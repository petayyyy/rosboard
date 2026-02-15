"use strict";

// TF Viewer v4.0 — Three.js
// 3D visualization of tf2_msgs/msg/TFMessage.
// Robot FBX model attached to base_link, frame axes, links, labels.

class TFViewer extends Viewer {
  onCreate() {
    this.allTransforms = {};
    this.allFrameIds = new Set();
    this.allChildFrameIds = new Set();
    this.visibleChildFrames = new Set();
    this.showLabels = true;
    this.selectedFrameId = null;
    this.axisScale = 0.3;
    this.showLinks = true;
    this._lastTree = null;

    this._frameAxes = {};
    this._frameLinks = {};
    this.robotModel = null;
    this.robotModelGroup = null;

    this._createControls();
    this._initThreeJS();

    this.labelsOverlay = $('<div></div>').css({
      "position": "absolute",
      "top": "0", "left": "0",
      "width": "100%", "height": "100%",
      "pointer-events": "none",
      "overflow": "hidden",
    }).appendTo(this.wrapper2);
    this.labelElements = {};

    this._loadRobotModel();
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

    this.frameCountLabel = $('<span></span>').addClass("monospace").css({"opacity": 0.4, "margin-left": "auto"}).appendTo(this.controlsBar);

    // collapsible child frames
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

    let that = this;
    this.frameIdSelect.on("change", function() {
      that.selectedFrameId = $(this).val() || null;
      that._clearFrameObjects();
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
      if (that.robotModelGroup) {
        that.robotModelGroup.visible = !!$(this).is(":checked");
      }
    });
  }

  // ── Three.js Initialization ────────────────────────────────

  _initThreeJS() {
    this.wrapper = $('<div></div>').css({
      "position": "relative", "width": "100%",
    }).appendTo(this.card.content);

    this.wrapper2 = $('<div></div>').css({
      "width": "100%",
      "aspect-ratio": "1",
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

    // Lighting (balanced for original FBX materials)
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

    let originAxes = new THREE.AxesHelper(0.5);
    this.scene.add(originAxes);

    this.framesGroup = new THREE.Group();
    this.linksGroup = new THREE.Group();
    this.scene.add(this.framesGroup);
    this.scene.add(this.linksGroup);

    // Render loop
    let that = this;
    let lastLabelTime = 0;
    let animate = () => {
      that._animFrameId = requestAnimationFrame(animate);
      that.orbitControls.update();
      that.renderer.render(that.scene, that.camera);
      let now = performance.now();
      if (now - lastLabelTime > 50) {
        lastLabelTime = now;
        that._updateLabels();
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
    let gridSize = 10;
    let gridDivisions = 10;
    let gridVerts = [];
    let half = gridSize / 2;
    let step = gridSize / gridDivisions;

    for (let i = 0; i <= gridDivisions; i++) {
      let pos = -half + i * step;
      gridVerts.push(pos, -half, 0, pos, half, 0);
      gridVerts.push(-half, pos, 0, half, pos, 0);
    }

    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(gridVerts, 3));
    let mat = new THREE.LineBasicMaterial({ color: 0x334466, transparent: true, opacity: 0.3 });
    this.scene.add(new THREE.LineSegments(geo, mat));
  }

  // ── Robot Model ────────────────────────────────────────────

  _loadRobotModel() {
    let that = this;

    // Group that follows base_link (model or fallback marker)
    this.robotModelGroup = new THREE.Group();
    this.scene.add(this.robotModelGroup);

    // Fallback marker: bright sphere visible immediately at base_link
    let markerGeo = new THREE.SphereGeometry(0.08, 16, 12);
    let markerMat = new THREE.MeshPhongMaterial({
      color: 0x00ffaa, emissive: 0x006644, transparent: true, opacity: 0.6,
    });
    this._fallbackMarker = new THREE.Mesh(markerGeo, markerMat);
    this.robotModelGroup.add(this._fallbackMarker);

    // Try loading FBX model
    if (typeof THREE === 'undefined' || typeof THREE.FBXLoader === 'undefined') {
      console.warn('[TFViewer] THREE.FBXLoader not available, using fallback marker');
      return;
    }

    let loader = new THREE.FBXLoader();
    loader.load('/models/obrik-sim2.fbx', (object) => {
      // FBXLoader converts to Three.js Y-up. Our scene is Z-up (ROS).
      // Correction: rotate +90° around X to convert Y-up → Z-up.
      let correction = new THREE.Group();
      correction.rotation.x = Math.PI / 2;
      correction.add(object);

      // Measure bounding box with correction applied
      correction.updateMatrixWorld(true);
      let box = new THREE.Box3().setFromObject(correction);
      let size = new THREE.Vector3();
      box.getSize(size);
      let maxDim = Math.max(size.x, size.y, size.z);
      let targetSize = 0.35;
      let s = maxDim > 0 ? targetSize / maxDim : 1.0;

      // Pivot: scale + center
      let pivot = new THREE.Group();
      pivot.add(correction);
      pivot.scale.set(s, s, s);

      // Center on bounding box
      pivot.updateMatrixWorld(true);
      box.setFromObject(pivot);
      let center = new THREE.Vector3();
      box.getCenter(center);
      // Shift inside correction to keep pivot at center
      correction.position.set(-center.x / s, -center.y / s, -center.z / s);

      // Keep original FBX materials
      object.traverse((child) => {
        if (child.isMesh && child.material) {
          let mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((m) => { m.side = THREE.DoubleSide; });
        }
      });

      // Remove fallback marker, add real model
      that.robotModelGroup.remove(that._fallbackMarker);
      that._fallbackMarker.geometry.dispose();
      that._fallbackMarker.material.dispose();
      that._fallbackMarker = null;

      that.robotModel = object;
      that._modelPivot = pivot;
      that._modelCorrection = correction;
      that.robotModelGroup.add(pivot);
      that.robotModelGroup.visible = that.showModelCheckbox.is(":checked");

      console.log('[TFViewer] Model loaded. bbox:', size.x.toFixed(1), 'x',
        size.y.toFixed(1), 'x', size.z.toFixed(1), ', scale:', s.toFixed(6));
    }, (xhr) => {
      if (xhr.total) {
        console.log('[TFViewer] Loading model:', Math.round(xhr.loaded / xhr.total * 100) + '%');
      }
    }, (error) => {
      console.warn('[TFViewer] FBX load failed, keeping fallback marker.', error.message || error);
    });
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
          rot.x || 0, rot.y || 0, rot.z || 0,
          rot.w == null ? 1 : rot.w
        ).normalize();

        let childPos = localPos.clone().applyQuaternion(parentQuat).add(parentPos);
        let childQuat = parentQuat.clone().multiply(localQuat);

        tree[childId] = {
          transform: tf,
          position: childPos,
          quaternion: childQuat,
          parentFrameId: frameId,
          parentPosition: parentPos.clone(),
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

    for (let childId in tree) {
      if (!this.visibleChildFrames.has(childId)) continue;
      activeChildIds.add(childId);

      let fd = tree[childId];

      // Frame axes (create once, reuse)
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

      // Link line
      if (this.showLinks && fd.parentPosition) {
        if (!this._frameLinks[childId]) {
          let mat = new THREE.LineBasicMaterial({
            color: 0x667788, transparent: true, opacity: 0.35,
          });
          let geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,0,0], 3));
          let line = new THREE.Line(geo, mat);
          this.linksGroup.add(line);
          this._frameLinks[childId] = line;
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
      if (childId === 'base_link' && this.robotModelGroup) {
        this.robotModelGroup.position.copy(fd.position);
        this.robotModelGroup.quaternion.copy(fd.quaternion);
      }
    }

    // Hide inactive objects
    for (let id in this._frameAxes) {
      if (!activeChildIds.has(id)) this._frameAxes[id].visible = false;
    }
    for (let id in this._frameLinks) {
      if (!activeChildIds.has(id)) this._frameLinks[id].visible = false;
    }

    this._updateLabels();
  }

  // ── Labels (HTML overlay) ──────────────────────────────────

  _project3DTo2D(pos) {
    let v = pos instanceof THREE.Vector3 ? pos.clone() : new THREE.Vector3(pos[0], pos[1], pos[2]);
    v.project(this.camera);
    if (Math.abs(v.x) > 2 || Math.abs(v.y) > 2 || v.z > 1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * 100,
      y: (-v.y * 0.5 + 0.5) * 100,
    };
  }

  _updateLabels() {
    if (!this.labelsOverlay) return;
    if (!this.showLabels || !this._lastTree) {
      this.labelsOverlay.css("display", "none");
      return;
    }
    this.labelsOverlay.css("display", "");

    let usedLabels = new Set();

    let rootName = this.selectedFrameId;
    if (rootName) {
      usedLabels.add(rootName);
      this._setLabel(rootName, this._project3DTo2D(new THREE.Vector3(0, 0, 0)), "#fff");
    }

    for (let childId in this._lastTree) {
      if (!this.visibleChildFrames.has(childId)) continue;
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
    this.labelElements[name].text(name).css({
      "display": "",
      "left": screenPos.x + "%",
      "top": screenPos.y + "%",
    });
  }

  // ── Data Handler ───────────────────────────────────────────

  onData(msg) {
    this._lastMsg = msg;
    this.card.title.text(msg._topic_name);

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

    this._updateDisplay();
  }

  // ── Cleanup ────────────────────────────────────────────────

  destroy() {
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
