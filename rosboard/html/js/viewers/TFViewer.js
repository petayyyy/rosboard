"use strict";

// TF Viewer v6.0 — Three.js + Plugin Architecture
// Orchestrates: TF frames, RobotModelPlugin, ArucoMarkerPlugin.
//
// One tree from /tf AND /tf_static: whichever of the two the card is opened
// on, the other one is pulled in as a secondary subscription (a card on /tf
// alone never saw base_link->camera or the ArUco map frames). rosboard sends
// TF as merged snapshots (/tf_static as deltas), so nothing is dropped here.
//
// ArUco maps (*/map/markers) are placed by their own TF frames — aruco_<id>
// for the main map, <map frame>_<id> for extra maps like aruco_land_1 — so the
// 3D map sits exactly where the localisation puts it. A map whose frame is not
// connected to the tree (aruco_land_1 before it is detected) is hidden instead
// of being dropped on the world origin. /aruco/det/markers highlights what the
// camera sees right now.

class TFViewer extends Viewer {
  onCreate() {
    // TF state
    this.allTransforms = {};
    this.allFrameIds = new Set();
    this.allChildFrameIds = new Set();
    this.visibleChildFrames = new Set();
    this.showLabels = true;
    this.selectedFrameId = null;
    this.axisScale = 0.3;
    this.showLinks = true;
    this._lastTree = null;

    // Three.js object pools
    this._frameAxes = {};
    this._frameLinks = {};

    // Secondary ArUco topic names we subscribed to (topic -> callback)
    this._arucoTopics = {};
    // Last message per ArUco source (topic -> msg)
    this._arucoSources = {};
    this._arucoStatus = {};
    // TF frames that are drawn as markers (axes/labels hidden by default)
    this._markerFrames = new Set();
    this.showMarkerFrames = false;
    this._lastArucoRefresh = 0;
    this._detectedAt = 0;
    this.follow = false;
    this._needsUpdate = false;

    // Full-window mode (rviz.html): canvas fills the card instead of 1:1
    this.fullPage = !!(this.card && this.card.hasClass && this.card.hasClass('rviz-card'));

    this._createControls();
    this._initThreeJS();

    // Labels overlay (shared by TF labels and plugins)
    this.labelsOverlay = $('<div></div>').css({
      "position": "absolute",
      "top": "0", "left": "0",
      "width": "100%", "height": "100%",
      "pointer-events": "none",
      "overflow": "hidden",
    }).appendTo(this.wrapper2);
    this.labelElements = {};

    // ── Plugins ──────────────────────────────────────────────
    this.robotPlugin = new RobotModelPlugin(this.scene, {
      modelUrl: '/models/obrik-sim2.fbx',
      targetSize: 0.35,
    });

    this.arucoPlugin = new ArucoMarkerPlugin(this.scene, this.labelsOverlay, this.camera);

    // The other half of the TF tree: /tf <-> /tf_static
    this._companionTopic = TFViewer.companionTopic(this.topicName);
    if (this._companionTopic) {
      this._onCompanionMsg = (msg) => this._ingestTF(msg);
      Viewer.subscribeSecondary(this._companionTopic, this._onCompanionMsg);
    }

    // ArUco topics appear asynchronously (and extra maps can show up later),
    // so keep discovering; it is a cheap scan of the topic list.
    let that = this;
    this._discoverArucoTopics();
    this._arucoDiscoveryInterval = setInterval(() => {
      that._discoverArucoTopics();
    }, 2000);
  }

  /** "/tf" -> "/tf_static", "/tf_static" -> "/tf". */
  static companionTopic(topicName) {
    if (!topicName) return null;
    if (topicName.endsWith("_static")) return topicName.slice(0, -"_static".length);
    return topicName + "_static";
  }

  // ── UI Controls ────────────────────────────────────────────

  _createControls() {
    this.controlsBar = $('<div></div>').css({
      "display": "flex", "flex-wrap": "wrap", "gap": "6px",
      "align-items": "center", "padding": "4px 0", "font-size": "10px",
    }).appendTo(this.card.content);

    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("frame:").appendTo(this.controlsBar);
    this.frameIdSelect = $('<select></select>').css({
      "max-width": "120px", "font-size": "10px",
      "background": "#333", "color": "#ddd",
      "border": "1px solid #555", "border-radius": "3px", "padding": "1px 2px",
    }).appendTo(this.controlsBar);

    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("scale:").appendTo(this.controlsBar);
    this.axisScaleInput = $('<input type="number" min="0.01" max="100" step="0.05">')
      .css({"width": "50px", "font-size": "10px", "background": "#333", "color": "#ddd",
        "border": "1px solid #555", "border-radius": "3px", "padding": "1px 2px"})
      .val(this.axisScale).appendTo(this.controlsBar);

    let linksLabel = $('<label></label>').css({"display": "flex", "gap": "3px", "align-items": "center", "cursor": "pointer"}).appendTo(this.controlsBar);
    this.showLinksCheckbox = $('<input type="checkbox" checked>').appendTo(linksLabel);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("links").appendTo(linksLabel);

    let labelsLabel = $('<label></label>').css({"display": "flex", "gap": "3px", "align-items": "center", "cursor": "pointer"}).appendTo(this.controlsBar);
    this.showLabelsCheckbox = $('<input type="checkbox" checked>').appendTo(labelsLabel);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("labels").appendTo(labelsLabel);

    let modelLabel = $('<label></label>').css({"display": "flex", "gap": "3px", "align-items": "center", "cursor": "pointer"}).appendTo(this.controlsBar);
    this.showModelCheckbox = $('<input type="checkbox" checked>').appendTo(modelLabel);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("model").appendTo(modelLabel);

    let arucoLabel = $('<label></label>').css({"display": "flex", "gap": "3px", "align-items": "center", "cursor": "pointer"}).appendTo(this.controlsBar);
    this.showArucoCheckbox = $('<input type="checkbox" checked>').appendTo(arucoLabel);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("aruco").appendTo(arucoLabel);

    // Green frame on the markers the camera sees right now
    let seenLabel = $('<label></label>').css({"display": "flex", "gap": "3px", "align-items": "center", "cursor": "pointer"}).appendTo(this.controlsBar);
    this.showSeenCheckbox = $('<input type="checkbox" checked>').appendTo(seenLabel);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("seen").appendTo(seenLabel);

    let markerFramesLabel = $('<label></label>').css({"display": "flex", "gap": "3px", "align-items": "center", "cursor": "pointer"}).appendTo(this.controlsBar);
    this.showMarkerFramesCheckbox = $('<input type="checkbox">').appendTo(markerFramesLabel);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("marker tf").appendTo(markerFramesLabel);

    // Keep the camera on the drone while it flies over the field
    this.followBtn = $('<button></button>').css({
      "font-size": "9px", "padding": "1px 6px",
      "background": "#444", "color": "#ccc",
      "border": "1px solid #666", "border-radius": "3px", "cursor": "pointer",
      "font-family": "'JetBrains Mono', monospace",
    }).text("follow").appendTo(this.controlsBar);

    // Camera mode toggle: orbit / fly
    this.cameraMode = 'orbit';
    this.cameraModeBtn = $('<button></button>').css({
      "font-size": "9px", "padding": "1px 6px",
      "background": "#444", "color": "#ccc",
      "border": "1px solid #666", "border-radius": "3px", "cursor": "pointer",
      "font-family": "'JetBrains Mono', monospace",
    }).text("orbit").appendTo(this.controlsBar);
    let that2 = this;
    this.cameraModeBtn.on("click", function() {
      that2._toggleCameraMode();
    });

    this.frameCountLabel = $('<span></span>').addClass("monospace").css({"opacity": 0.4, "margin-left": "auto"}).appendTo(this.controlsBar);

    // Per-map ArUco status: "map 59 · aruco_land_1: no TF"
    this.arucoStatusLabel = $('<div></div>').addClass("monospace").css({
      "font-size": "9px", "opacity": 0.55, "padding": "0 0 2px 0", "white-space": "nowrap",
      "overflow": "hidden", "text-overflow": "ellipsis",
    }).appendTo(this.card.content);

    // Collapsible child frames
    this.childToggle = $('<div></div>').css({
      "display": "flex", "align-items": "center", "gap": "4px",
      "cursor": "pointer", "padding": "2px 0", "font-size": "10px", "user-select": "none",
    }).appendTo(this.card.content);
    this.childToggleArrow = $('<span></span>').text("\u25B6").css({"opacity": 0.5, "font-size": "8px", "transition": "transform 0.2s"}).appendTo(this.childToggle);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("frames").appendTo(this.childToggle);

    this.childFramesPanel = $('<div></div>').css({
      "display": "none", "max-height": "120px", "overflow-y": "auto",
      "border": "1px solid rgba(255,255,255,0.1)", "border-radius": "3px",
      "padding": "4px", "margin-bottom": "4px",
      "column-count": "2", "column-gap": "8px", "font-size": "10px",
    }).appendTo(this.card.content);
    this.childFramesList = $('<div></div>').appendTo(this.childFramesPanel);

    let childPanelVisible = false;
    this.childToggle.on("click", () => {
      childPanelVisible = !childPanelVisible;
      this.childFramesPanel.css("display", childPanelVisible ? "" : "none");
      this.childToggleArrow.css("transform", childPanelVisible ? "rotate(90deg)" : "none");
    });

    // Event handlers
    let that = this;
    this.frameIdSelect.on("change", function() {
      that.selectedFrameId = $(this).val() || null;
      that._clearFrameObjects();
      that._lastArucoRefresh = 0;
      that._updateDisplay();
    });
    this.axisScaleInput.on("change input", function() {
      let v = parseFloat($(this).val());
      if (!Number.isFinite(v) || v <= 0) v = 0.3;
      that.axisScale = v;
      that._updateDisplay();
    });
    this.showLinksCheckbox.on("change", function() {
      that.showLinks = !!$(this).is(":checked");
      that._updateDisplay();
    });
    this.showLabelsCheckbox.on("change", function() {
      that.showLabels = !!$(this).is(":checked");
      that._updateLabels();
    });
    this.showModelCheckbox.on("change", function() {
      if (that.robotPlugin) that.robotPlugin.setVisible(!!$(this).is(":checked"));
    });
    this.showArucoCheckbox.on("change", function() {
      if (that.arucoPlugin) that.arucoPlugin.setVisible(!!$(this).is(":checked"));
    });
    this.showSeenCheckbox.on("change", function() {
      if (that.arucoPlugin) that.arucoPlugin.setHighlightEnabled(!!$(this).is(":checked"));
    });
    this.showMarkerFramesCheckbox.on("change", function() {
      that.showMarkerFrames = !!$(this).is(":checked");
      that._updateDisplay();
    });
    this.followBtn.on("click", function() {
      that.follow = !that.follow;
      that.followBtn.css({"background": that.follow ? "#335" : "#444"});
      if (that.follow && that.cameraMode === 'fly') that._enableOrbitMode();
    });
  }

  // ── Three.js Initialization ────────────────────────────────

  _initThreeJS() {
    this.wrapper = $('<div></div>').addClass('tf-wrap').css({
      "position": "relative", "width": "100%",
    }).appendTo(this.card.content);

    // 1:1 in a rosboard card; fills the window on rviz.html (see its CSS)
    this.wrapper2 = $('<div></div>').addClass('tf-canvas-wrap').css({
      "width": "100%",
      "aspect-ratio": this.fullPage ? "auto" : "1",
      "background": "#1a1a2e",
      "position": "relative",
      "overflow": "hidden",
    }).appendTo(this.wrapper);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.scene.fog = new THREE.FogExp2(0x1a1a2e, 0.035);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
    this.camera.position.set(4, -6, 5);
    this.camera.up.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(500, 500);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.wrapper2[0].appendChild(this.renderer.domElement);
    $(this.renderer.domElement).css({
      "position": "absolute",
      "top": "0", "left": "0",
      "width": "100%", "height": "100%",
    });

    this.orbitControls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.target.set(0, 0, 1.5);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.12;
    this.orbitControls.minDistance = 0.5;
    this.orbitControls.maxDistance = 100;
    this.orbitControls.update();

    // Lighting
    this.scene.add(new THREE.AmbientLight(0xcccccc, 0.7));
    let dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(5, -3, 10);
    this.scene.add(dirLight);
    let fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-5, 5, 2);
    this.scene.add(fillLight);
    let backLight = new THREE.DirectionalLight(0x8899bb, 0.3);
    backLight.position.set(0, 0, -5);
    this.scene.add(backLight);

    this._createGrid();
    this.scene.add(new THREE.AxesHelper(0.5));

    this.framesGroup = new THREE.Group();
    this.linksGroup = new THREE.Group();
    this.scene.add(this.framesGroup);
    this.scene.add(this.linksGroup);

    // Render loop
    let that = this;
    let lastLabelTime = 0;
    let lastFrameTime = performance.now();
    let animate = () => {
      that._animFrameId = requestAnimationFrame(animate);
      let now = performance.now();
      let delta = Math.min((now - lastFrameTime) / 1000, 0.1); // seconds, capped
      lastFrameTime = now;

      // Many TF messages per frame -> one tree rebuild per frame
      if (that._needsUpdate && !that.isPaused) {
        that._needsUpdate = false;
        that._updateDisplay();
      }
      if (that.follow) that._followBaseLink();
      if (that._detectedAt && now - that._detectedAt > 1000) {
        that._detectedAt = 0;
        if (that.arucoPlugin) that.arucoPlugin.setDetected([]);
      }

      if (that.cameraMode === 'fly') {
        that._updateFlyMovement(delta);
      } else {
        that.orbitControls.update();
      }
      if (that.robotPlugin) that.robotPlugin.updateSmooth(delta);
      if (that.arucoPlugin) that.arucoPlugin.updateSmooth(delta);
      that.renderer.render(that.scene, that.camera);
      if (now - lastLabelTime > 50) {
        lastLabelTime = now;
        that._updateLabels();
        if (that.arucoPlugin) that.arucoPlugin.updateLabels();
      }
    };
    animate();

    // Resize
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(() => {
        let w = that.wrapper2[0].clientWidth;
        let h = that.wrapper2[0].clientHeight;
        if (w > 0 && h > 0) {
          that.renderer.setSize(w, h);
          that.camera.aspect = w / h;
          that.camera.updateProjectionMatrix();
        }
      });
      this._resizeObserver.observe(this.wrapper2[0]);
    }
  }

  _createGrid() {
    let gridSize = 10, gridDivisions = 10;
    let verts = [], half = gridSize / 2, step = gridSize / gridDivisions;
    for (let i = 0; i <= gridDivisions; i++) {
      let pos = -half + i * step;
      verts.push(pos, -half, 0, pos, half, 0);
      verts.push(-half, pos, 0, half, pos, 0);
    }
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.scene.add(new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: 0x334466, transparent: true, opacity: 0.3 })));
  }

  // ── Camera Mode (Orbit / Fly) ──────────────────────────────

  _toggleCameraMode() {
    if (this.cameraMode === 'orbit') {
      this._enableFlyMode();
    } else {
      this._enableOrbitMode();
    }
  }

  _enableOrbitMode() {
    this.cameraMode = 'orbit';
    this.cameraModeBtn.text('orbit').css({"background": "#444"});
    this.orbitControls.enabled = true;
    this._cleanupFlyMode();
  }

  _enableFlyMode() {
    this.cameraMode = 'fly';
    this.cameraModeBtn.text('fly').css({"background": "#335"});
    this.orbitControls.enabled = false;
    this._initFlyMode();
  }

  _initFlyMode() {
    let that = this;
    this._flyKeys = {};
    this._flySpeed = 3.0;
    this._flyDragging = false;
    this._flyLastMouse = { x: 0, y: 0 };

    // Extract current yaw/pitch from camera direction (Z-up world)
    let dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this._flyYaw = Math.atan2(dir.y, dir.x);
    this._flyPitch = Math.asin(Math.max(-0.999, Math.min(0.999, dir.z)));
    this._applyFlyCamera();

    this._flyOnKeyDown = (e) => {
      that._flyKeys[e.code] = true;
      if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','Space','ShiftLeft','ShiftRight'].includes(e.code)) {
        e.preventDefault();
      }
    };
    this._flyOnKeyUp = (e) => { that._flyKeys[e.code] = false; };

    this._flyOnMouseDown = (e) => {
      if (e.button === 0 || e.button === 2) {
        that._flyDragging = true;
        that._flyLastMouse = { x: e.clientX, y: e.clientY };
      }
    };
    this._flyOnMouseUp = () => { that._flyDragging = false; };
    this._flyOnMouseMove = (e) => {
      if (!that._flyDragging) return;
      let dx = e.clientX - that._flyLastMouse.x;
      let dy = e.clientY - that._flyLastMouse.y;
      that._flyLastMouse = { x: e.clientX, y: e.clientY };
      let sensitivity = 0.003;
      // Horizontal mouse → yaw (rotate around Z in Z-up world)
      that._flyYaw -= dx * sensitivity;
      // Vertical mouse → pitch (mouse down = look down, standard FPS)
      that._flyPitch -= dy * sensitivity;
      // Clamp pitch to avoid flipping
      that._flyPitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, that._flyPitch));
      that._applyFlyCamera();
    };
    this._flyOnContextMenu = (e) => { e.preventDefault(); };

    let el = this.renderer.domElement;
    el.setAttribute('tabindex', '0');
    el.focus();
    document.addEventListener('keydown', this._flyOnKeyDown);
    document.addEventListener('keyup', this._flyOnKeyUp);
    el.addEventListener('mousedown', this._flyOnMouseDown);
    document.addEventListener('mouseup', this._flyOnMouseUp);
    document.addEventListener('mousemove', this._flyOnMouseMove);
    el.addEventListener('contextmenu', this._flyOnContextMenu);

    // Fly hint overlay
    if (!this._flyHint) {
      this._flyHint = $('<div></div>').css({
        "position": "absolute", "bottom": "6px", "left": "50%",
        "transform": "translateX(-50%)", "font-size": "8px",
        "font-family": "'JetBrains Mono', monospace",
        "color": "rgba(200,200,220,0.5)", "white-space": "nowrap",
        "pointer-events": "none",
      }).text("WASD move  QE up/down  Shift fast  drag look").appendTo(this.wrapper2);
    }
    this._flyHint.css("display", "");
  }

  /** Apply yaw/pitch to camera via lookAt (Z-up world). */
  _applyFlyCamera() {
    let dir = new THREE.Vector3(
      Math.cos(this._flyPitch) * Math.cos(this._flyYaw),
      Math.cos(this._flyPitch) * Math.sin(this._flyYaw),
      Math.sin(this._flyPitch)
    );
    let target = this.camera.position.clone().add(dir);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(target);
  }

  _cleanupFlyMode() {
    if (this._flyOnKeyDown) {
      document.removeEventListener('keydown', this._flyOnKeyDown);
      document.removeEventListener('keyup', this._flyOnKeyUp);
      let el = this.renderer.domElement;
      el.removeEventListener('mousedown', this._flyOnMouseDown);
      document.removeEventListener('mouseup', this._flyOnMouseUp);
      document.removeEventListener('mousemove', this._flyOnMouseMove);
      el.removeEventListener('contextmenu', this._flyOnContextMenu);
    }
    this._flyKeys = {};
    this._flyOnKeyDown = null;
    if (this._flyHint) this._flyHint.css("display", "none");
  }

  _updateFlyMovement(delta) {
    if (this.cameraMode !== 'fly' || !this._flyKeys) return;
    let speed = this._flySpeed * delta;
    if (this._flyKeys['ShiftLeft'] || this._flyKeys['ShiftRight']) speed *= 3;

    // Forward direction on the horizontal XY plane (Z-up, yaw only)
    let fwdX = Math.cos(this._flyYaw);
    let fwdY = Math.sin(this._flyYaw);
    // Right = perpendicular in XY plane
    let rightX = Math.sin(this._flyYaw);
    let rightY = -Math.cos(this._flyYaw);

    let moved = false;
    if (this._flyKeys['KeyW']) { this.camera.position.x += fwdX * speed; this.camera.position.y += fwdY * speed; moved = true; }
    if (this._flyKeys['KeyS']) { this.camera.position.x -= fwdX * speed; this.camera.position.y -= fwdY * speed; moved = true; }
    if (this._flyKeys['KeyD']) { this.camera.position.x += rightX * speed; this.camera.position.y += rightY * speed; moved = true; }
    if (this._flyKeys['KeyA']) { this.camera.position.x -= rightX * speed; this.camera.position.y -= rightY * speed; moved = true; }
    if (this._flyKeys['KeyQ'] || this._flyKeys['Space']) { this.camera.position.z += speed; moved = true; }
    if (this._flyKeys['KeyE']) { this.camera.position.z -= speed; moved = true; }

    if (moved) this._applyFlyCamera();
  }

  // ── ArUco Topic Discovery ──────────────────────────────────

  _discoverArucoTopics() {
    let topics = Viewer._topics;
    if (!topics) return;

    let arucoTypes = [
      'aruco_det_loc/msg/MarkerArray',
      'visualization_msgs/msg/MarkerArray',
      'visualization_msgs/MarkerArray',
    ];

    for (let topicName in topics) {
      if (this._arucoTopics[topicName]) continue;
      if (!arucoTypes.includes(topics[topicName])) continue;
      let cb = (msg) => this._onArucoData(msg, topicName);
      this._arucoTopics[topicName] = cb;
      Viewer.subscribeSecondary(topicName, cb);
      console.log('[TFViewer] Auto-subscribed to ArUco topic:', topicName);
    }
  }

  /** Map topics carry the whole map; det topics the current detections. */
  static arucoSourceKind(topicName) {
    if (/\/det\/markers$/.test(topicName)) return 'det';
    if (/\/map\/markers$/.test(topicName)) return 'map';
    return 'generic';
  }

  _onArucoData(msg, topicName) {
    if (!this.arucoPlugin) return;
    this._arucoSources[topicName] = msg;

    if (TFViewer.arucoSourceKind(topicName) === 'det') {
      let ids = (msg.markers || []).map((m) => m && m.id).filter((id) => id != null);
      this.arucoPlugin.setDetected(ids);
      this._detectedAt = performance.now();
    }
    this._refreshArucoSource(topicName);
  }

  /** Re-place every source against the current TF tree. */
  _refreshAruco() {
    this._markerFrames = new Set();
    for (let topicName in this._arucoSources) this._refreshArucoSource(topicName);
    this._lastArucoRefresh = performance.now();
    this._renderArucoStatus();
  }

  _refreshArucoSource(topicName) {
    let msg = this._arucoSources[topicName];
    if (!msg || !this.arucoPlugin) return;
    let kind = TFViewer.arucoSourceKind(topicName);
    let placed;
    if (kind === 'map') placed = this._placeMapMarkers(msg, topicName);
    else if (kind === 'det') placed = this._placeDetectedMarkers(msg, topicName);
    else placed = this._placeGenericMarkers(msg);
    this.arucoPlugin.updateMarkers(placed, topicName);
  }

  /** Root-frame pose of a TF frame, or null if it is not connected to root. */
  _framePose(frameId) {
    let ft = TFUtils.getFrameWorldTransform(frameId, this.selectedFrameId, this._lastTree);
    if (!ft) return null;
    return {
      position: { x: ft.position.x, y: ft.position.y, z: ft.position.z },
      orientation: { x: ft.quaternion.x, y: ft.quaternion.y, z: ft.quaternion.z, w: ft.quaternion.w },
    };
  }

  _placeMapMarkers(msg, topicName) {
    let frameId = msg.header?.frame_id || "";
    let markers = msg.markers || [];
    let out = [];
    let viaTf = 0;
    for (let i = 0; i < markers.length; i++) {
      let m = markers[i];
      if (!m || m.id == null) continue;
      // aruco_map publishes one static frame per marker: <map frame>_<id>
      // for extra maps (aruco_land_1_100), aruco_<id> for the main one.
      let pose = null;
      for (let frame of [frameId + "_" + m.id, "aruco_" + m.id]) {
        pose = this._framePose(frame);
        if (pose) { this._markerFrames.add(frame); viaTf++; break; }
      }
      // No per-marker frame: fall back to the message pose, but only if its
      // frame is connected to the tree — never guess the origin.
      if (!pose && (frameId === this.selectedFrameId || (this._lastTree && this._lastTree[frameId]))) {
        pose = TFUtils.transformPose(m.pose, frameId, this.selectedFrameId, this._lastTree);
      }
      if (pose) out.push({ id: m.id, size: m.size, pose: pose });
    }
    this._arucoStatus[topicName] = out.length
      ? { label: this._mapLabel(topicName, frameId), text: String(out.length) + (viaTf ? "" : " (msg)") }
      : { label: this._mapLabel(topicName, frameId), text: "no TF for " + frameId, bad: true };
    return out;
  }

  _mapLabel(topicName, frameId) {
    let m = /\/aruco\/(.+)\/map\/markers$/.exec(topicName);
    return m ? m[1] : (frameId === "map" ? "map" : frameId || topicName);
  }

  /**
   * Detections with their own PnP pose (markers outside every map) — map
   * markers are already drawn by the map sources and are only highlighted.
   */
  _placeDetectedMarkers(msg, topicName) {
    let frameId = msg.header?.frame_id || "";
    if (!frameId || !(frameId === this.selectedFrameId || (this._lastTree && this._lastTree[frameId]))) return [];
    let onMaps = this.arucoPlugin.placedIdsExcept(topicName);
    let out = [];
    (msg.markers || []).forEach((m) => {
      if (!m || m.id == null || onMaps.has(Number(m.id))) return;
      if (!TFUtils.isPoseUsable(m.pose)) return;
      let pose = TFUtils.transformPose(m.pose, frameId, this.selectedFrameId, this._lastTree);
      if (pose) out.push({ id: m.id, size: m.size, pose: pose });
    });
    return out;
  }

  /** visualization_msgs/MarkerArray: per-marker header.frame_id. */
  _placeGenericMarkers(msg) {
    let markers = msg.markers || [];
    let hasPerMarkerHeader = !!(markers[0] && markers[0].header && typeof markers[0].header.frame_id === "string");
    let out = [];
    if (!hasPerMarkerHeader) {
      let frameId = msg.header?.frame_id || "";
      if (!frameId) return out;
      return TFUtils.transformMarkers(markers, frameId, this.selectedFrameId, this._lastTree) || [];
    }
    markers.forEach((m) => {
      if (!m || m.id == null) return;
      let frameId = m.header?.frame_id || "";
      if (!frameId) return;
      let pose = m.pose ? { position: m.pose.position, orientation: m.pose.orientation } : null;
      let size = (m.scale && (m.scale.x || m.scale.y)) ? Math.max(m.scale.x || 0, m.scale.y || 0) : undefined;
      let t = TFUtils.transformPose(pose, frameId, this.selectedFrameId, this._lastTree);
      if (t) out.push({ id: m.id, size: size, pose: t });
    });
    return out;
  }

  _renderArucoStatus() {
    if (!this.arucoStatusLabel) return;
    let parts = [];
    for (let topic in this._arucoStatus) {
      let st = this._arucoStatus[topic];
      parts.push((st.bad ? "\u26A0 " : "") + st.label + ": " + st.text);
    }
    for (let topic in this._arucoSources) {
      if (TFViewer.arucoSourceKind(topic) !== 'det' || !this._detectedAt) continue;
      parts.push("seen: " + (this._arucoSources[topic].markers || []).length);
    }
    this.arucoStatusLabel.text(parts.length ? "aruco  " + parts.join("  \u00B7  ") : "");
  }

  // ── TF Data Management ────────────────────────────────────

  _storeTransform(transform) {
    let parent = transform?.header?.frame_id;
    let child = transform?.child_frame_id;
    if (!parent || !child) return false;
    this.allTransforms[parent + "->" + child] = transform;
    let wasNew = !this.allFrameIds.has(parent) || !this.allChildFrameIds.has(child);
    this.allFrameIds.add(parent);
    this.allChildFrameIds.add(child);
    return wasNew;
  }

  _updateFrameIdOptions() {
    let frameIds = Array.from(this.allFrameIds).sort();
    let currentValue = this.frameIdSelect.val();
    this.frameIdSelect.empty();

    if (frameIds.length === 0) {
      $('<option></option>').text("(none)").appendTo(this.frameIdSelect);
      this.selectedFrameId = null;
      return;
    }
    frameIds.forEach((fid) => {
      $('<option></option>').attr("value", fid).text(fid).appendTo(this.frameIdSelect);
    });
    if (currentValue && frameIds.includes(currentValue)) {
      this.frameIdSelect.val(currentValue);
      this.selectedFrameId = currentValue;
    } else if (!this.selectedFrameId || !frameIds.includes(this.selectedFrameId)) {
      this.selectedFrameId = frameIds.includes("map") ? "map" : frameIds[0];
      this.frameIdSelect.val(this.selectedFrameId);
    }
  }

  _updateChildFramesList() {
    let childFrames = Array.from(this.allChildFrameIds).sort();
    this.childFramesList.empty();
    if (childFrames.length === 0) return;
    if (this.visibleChildFrames.size === 0) {
      childFrames.forEach((cfid) => this.visibleChildFrames.add(cfid));
    }
    let that = this;
    childFrames.forEach((cfid) => {
      let row = $('<label></label>').css({
        "display": "flex", "gap": "3px", "align-items": "center",
        "cursor": "pointer", "break-inside": "avoid", "line-height": "1.6",
      }).appendTo(this.childFramesList);
      let checkbox = $('<input type="checkbox">')
        .prop("checked", this.visibleChildFrames.has(cfid)).appendTo(row);
      checkbox.on("change", function() {
        if ($(this).is(":checked")) that.visibleChildFrames.add(cfid);
        else that.visibleChildFrames.delete(cfid);
        that._updateDisplay();
      });
      $('<span></span>').addClass("monospace").css({"opacity": 0.8}).text(cfid).appendTo(row);
    });
    this.frameCountLabel.text(childFrames.length + " frames");
  }

  // ── Transform Tree ─────────────────────────────────────────

  _buildTransformTree(rootFrameId) {
    let tree = {};
    let visited = new Set();
    let buildTree = (frameId, parentPos, parentQuat) => {
      if (visited.has(frameId)) return;
      visited.add(frameId);
      for (let key in this.allTransforms) {
        let tf = this.allTransforms[key];
        if (tf?.header?.frame_id !== frameId) continue;
        let childId = tf?.child_frame_id;
        if (!childId) continue;
        let tr = tf?.transform?.translation;
        let rot = tf?.transform?.rotation;
        if (!tr || !rot) continue;
        let localPos = new THREE.Vector3(tr.x || 0, tr.y || 0, tr.z || 0);
        let localQuat = new THREE.Quaternion(
          rot.x || 0, rot.y || 0, rot.z || 0, rot.w == null ? 1 : rot.w
        ).normalize();
        let childPos = localPos.clone().applyQuaternion(parentQuat).add(parentPos);
        let childQuat = parentQuat.clone().multiply(localQuat);
        tree[childId] = {
          transform: tf, position: childPos, quaternion: childQuat,
          parentFrameId: frameId, parentPosition: parentPos.clone(),
        };
        buildTree(childId, childPos, childQuat);
      }
    };
    buildTree(rootFrameId, new THREE.Vector3(), new THREE.Quaternion());
    return tree;
  }

  // ── 3D Scene Update ────────────────────────────────────────

  _clearFrameObjects() {
    for (let id in this._frameAxes) {
      this.framesGroup.remove(this._frameAxes[id]);
      this._frameAxes[id].dispose();
    }
    this._frameAxes = {};
    for (let id in this._frameLinks) {
      this.linksGroup.remove(this._frameLinks[id]);
      this._frameLinks[id].geometry.dispose();
      this._frameLinks[id].material.dispose();
    }
    this._frameLinks = {};
  }

  _updateDisplay() {
    if (!this.selectedFrameId) return;
    let scale = this.axisScale;
    if (!Number.isFinite(scale) || scale <= 0) scale = 0.3;

    let tree = this._buildTransformTree(this.selectedFrameId);
    this._lastTree = tree;
    let activeChildIds = new Set();

    // Markers follow the tree (map offset, root change); 5 Hz is plenty
    if (performance.now() - this._lastArucoRefresh > 200) this._refreshAruco();

    for (let childId in tree) {
      if (!this.visibleChildFrames.has(childId)) continue;
      if (!this.showMarkerFrames && this._markerFrames.has(childId)) continue;
      activeChildIds.add(childId);
      let fd = tree[childId];

      // Frame axes
      if (!this._frameAxes[childId]) {
        let axes = new THREE.AxesHelper(1.0);
        this.framesGroup.add(axes);
        this._frameAxes[childId] = axes;
      }
      let axes = this._frameAxes[childId];
      axes.position.copy(fd.position);
      axes.quaternion.copy(fd.quaternion);
      axes.scale.setScalar(scale);
      axes.visible = true;

      // Link lines
      if (this.showLinks && fd.parentPosition) {
        if (!this._frameLinks[childId]) {
          let mat = new THREE.LineBasicMaterial({ color: 0x667788, transparent: true, opacity: 0.35 });
          let geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,0,0], 3));
          this.linksGroup.add(new THREE.Line(geo, mat));
          this._frameLinks[childId] = this.linksGroup.children[this.linksGroup.children.length - 1];
        }
        let posAttr = this._frameLinks[childId].geometry.attributes.position;
        posAttr.setXYZ(0, fd.parentPosition.x, fd.parentPosition.y, fd.parentPosition.z);
        posAttr.setXYZ(1, fd.position.x, fd.position.y, fd.position.z);
        posAttr.needsUpdate = true;
        this._frameLinks[childId].visible = true;
      } else if (this._frameLinks[childId]) {
        this._frameLinks[childId].visible = false;
      }

      // Robot model follows base_link
      if (childId === 'base_link' && this.robotPlugin) {
        this.robotPlugin.setTransform(fd.position, fd.quaternion);
      }
    }

    // Robot model always follows base_link, even if frame is hidden
    if (!activeChildIds.has('base_link') && tree['base_link'] && this.robotPlugin) {
      this.robotPlugin.setTransform(tree['base_link'].position, tree['base_link'].quaternion);
    }

    // Hide inactive
    for (let id in this._frameAxes) {
      if (!activeChildIds.has(id)) this._frameAxes[id].visible = false;
    }
    for (let id in this._frameLinks) {
      if (!activeChildIds.has(id)) this._frameLinks[id].visible = false;
    }

    this._updateLabels();
  }

  // ── Labels (HTML overlay for TF frames) ────────────────────

  _project3DTo2D(pos) {
    let v = pos instanceof THREE.Vector3 ? pos.clone() : new THREE.Vector3(pos[0], pos[1], pos[2]);
    v.project(this.camera);
    if (Math.abs(v.x) > 2 || Math.abs(v.y) > 2 || v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * 100, y: (-v.y * 0.5 + 0.5) * 100 };
  }

  _updateLabels() {
    if (!this.labelsOverlay) return;
    if (!this.showLabels || !this._lastTree) {
      // Only hide TF labels, not aruco labels
      for (let name in this.labelElements) {
        this.labelElements[name].css("display", "none");
      }
      return;
    }

    let usedLabels = new Set();
    let rootName = this.selectedFrameId;
    if (rootName) {
      usedLabels.add(rootName);
      this._setLabel(rootName, this._project3DTo2D(new THREE.Vector3(0, 0, 0)), "#fff");
    }
    for (let childId in this._lastTree) {
      if (!this.visibleChildFrames.has(childId)) continue;
      if (!this.showMarkerFrames && this._markerFrames.has(childId)) continue;
      usedLabels.add(childId);
      this._setLabel(childId, this._project3DTo2D(this._lastTree[childId].position), "#ccc");
    }
    for (let name in this.labelElements) {
      if (!usedLabels.has(name)) {
        this.labelElements[name].remove();
        delete this.labelElements[name];
      }
    }
  }

  _setLabel(name, screenPos, color) {
    if (!screenPos || screenPos.x < -10 || screenPos.x > 110 || screenPos.y < -10 || screenPos.y > 110) {
      if (this.labelElements[name]) this.labelElements[name].css("display", "none");
      return;
    }
    if (!this.labelElements[name]) {
      this.labelElements[name] = $('<div></div>').css({
        "position": "absolute",
        "font-size": "9px",
        "font-family": "'JetBrains Mono', monospace",
        "color": color,
        "text-shadow": "0 0 3px #000, 0 0 6px #000",
        "white-space": "nowrap",
        "pointer-events": "none",
        "transform": "translate(-50%, -100%)",
        "padding-bottom": "2px",
      }).appendTo(this.labelsOverlay);
    }
    // gz frames look like "x500_obrik_base_battery_0/.../obrik_rangefinder_down"
    this.labelElements[name].text(name.split("/").pop()).css({
      "display": "", "left": screenPos.x + "%", "top": screenPos.y + "%",
    });
  }

  // ── Data Handler ───────────────────────────────────────────

  /**
   * TF must not be thinned out on the client: rosboard already rate-limits
   * the snapshots, and a dropped /tf_static delta would never come back.
   * Paused = keep collecting, just don't redraw.
   */
  update(data) {
    if (this.loaderContainer) {
      this.loaderContainer.remove();
      this.loaderContainer = null;
    }
    if (data._error) { this.error(data._error); return; }
    this.onData(data);
  }

  onData(msg) {
    this._lastMsg = msg;
    this.card.title.text(this._companionTopic ? msg._topic_name + " + " + this._companionTopic : msg._topic_name);
    this._ingestTF(msg);
  }

  _ingestTF(msg) {
    let transforms = msg.transforms || [];
    if (!Array.isArray(transforms) || transforms.length === 0) return;

    let hasNewFrames = false;
    let prevCount = this.allChildFrameIds.size;
    for (let i = 0; i < transforms.length; i++) {
      if (this._storeTransform(transforms[i])) hasNewFrames = true;
    }
    if (hasNewFrames) {
      this._updateFrameIdOptions();
      if (this.allChildFrameIds.size > prevCount) {
        this.allChildFrameIds.forEach((cfid) => this.visibleChildFrames.add(cfid));
      }
      this._updateChildFramesList();
    }
    this._needsUpdate = true;
  }

  /** Orbit target and camera follow base_link (orbit mode only). */
  _followBaseLink() {
    let fd = this._lastTree && this._lastTree['base_link'];
    if (!fd || this.cameraMode !== 'orbit') return;
    let delta = fd.position.clone().sub(this.orbitControls.target);
    if (delta.lengthSq() < 1e-8) return;
    this.orbitControls.target.add(delta);
    this.camera.position.add(delta);
  }

  // ── Cleanup ────────────────────────────────────────────────

  destroy() {
    // Unsubscribe secondary topics (only our own handlers)
    for (let topicName in this._arucoTopics) {
      Viewer.unsubscribeSecondary(topicName, this._arucoTopics[topicName]);
    }
    this._arucoTopics = {};
    if (this._companionTopic && this._onCompanionMsg) {
      Viewer.unsubscribeSecondary(this._companionTopic, this._onCompanionMsg);
    }
    if (this._arucoDiscoveryInterval) clearInterval(this._arucoDiscoveryInterval);

    // Destroy plugins
    if (this.robotPlugin) this.robotPlugin.destroy();
    if (this.arucoPlugin) this.arucoPlugin.destroy();

    // Three.js cleanup
    this._cleanupFlyMode();
    if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._clearFrameObjects();
    if (this.orbitControls) this.orbitControls.dispose();
    if (this.renderer) this.renderer.dispose();
  }
}

TFViewer.friendlyName = "TF (3D)";
TFViewer.supportedTypes = [
  "tf2_msgs/msg/TFMessage",
];
TFViewer.maxUpdateRate = 30.0;

Viewer.registerViewer(TFViewer);
