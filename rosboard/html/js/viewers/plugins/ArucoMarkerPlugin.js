"use strict";

// ArucoMarkerPlugin — renders ArUco markers as textured planes with the real
// DICT_4X4_1000 pattern (ArucoDictionary.js), plus an id label.
//
// Markers come from several sources at once — the main map, extra maps
// (aruco_land_1, ...), live detections — and each source owns its own set:
// updateMarkers(markers, source) only shows/hides markers of that source.
// (Before, every MarkerArray replaced the whole set, so /aruco/det/markers,
// /aruco/map/markers and /aruco/aruco_land_1/map/markers blanked each other
// out in turn and the map flickered between 9, 41 and 59 markers.)
//
// Marker format (already transformed into the viewer's root frame):
//   { id, size, pose: {position, orientation} }
// A marker without a usable pose is skipped unless it was placed before, in
// which case it holds its last pose (see TFUtils.isPoseUsable).
//
// setDetected(ids) highlights the markers the camera sees right now.

class ArucoMarkerPlugin {
  /**
   * @param {THREE.Scene} scene
   * @param {jQuery} labelsOverlay - HTML overlay div for labels
   * @param {THREE.Camera} camera - for 3D→2D label projection
   */
  constructor(scene, labelsOverlay, camera) {
    this.scene = scene;
    this.labelsOverlay = labelsOverlay;
    this.camera = camera;

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this._markerObjects = {};   // "source|id" → { smooth, mesh, halo, ... }
    this._textureCache = {};    // id → THREE.CanvasTexture
    this._labelElements = {};   // key → jQuery element
    this._placed = {};          // source → [{ key, id, pose }]
    this._detected = new Set(); // ids seen by the camera right now
    this._highlight = true;     // colour the detected ones (UI checkbox)
    this._visible = true;
    this._smoothSpeed = 14;     // SmoothTransform speed (map offset moves a bit)
  }

  // ── ArUco Texture Generation ─────────────────────────────

  /**
   * 6×6 cells: 1-cell black border + 4×4 data from DICT_4X4_1000. Ids outside
   * the dictionary fall back to a hash pattern so they still look distinct.
   */
  _generateArucoTexture(id) {
    if (this._textureCache[id]) return this._textureCache[id];

    let gridSize = 6;
    let cellPx = 32;
    let canvasSize = gridSize * cellPx;

    let canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    let ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    let bits = (typeof ArucoDictionary !== 'undefined' && ArucoDictionary.bits(id)) || this._hashBits(id);
    ctx.fillStyle = '#ffffff';
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        if (!bits[row * 4 + col]) {
          ctx.fillRect((col + 1) * cellPx, (row + 1) * cellPx, cellPx, cellPx);
        }
      }
    }

    let texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    this._textureCache[id] = texture;
    return texture;
  }

  _hashBits(id) {
    let v = ((Number(id) + 1) * 2654435761) >>> 0;
    let bits = [];
    for (let i = 0; i < 16; i++) bits.push((v >> i) & 1);
    return bits;
  }

  // ── Marker mesh creation ───────────────────────────────────

  _getOrCreateMarker(key, id, size) {
    let obj = this._markerObjects[key];
    let markerSize = size || 0.15;
    if (obj && Math.abs(obj.size - markerSize) < 1e-6) return obj;
    if (obj) this._disposeMarker(key);

    let smooth = new SmoothTransform(this.group, { speed: this._smoothSpeed, snapDistance: 1.5 });

    // Lifted a few mm above the marker frame: the ground grid lies at z=0 and
    // would z-fight with a plane exactly on it.
    let geo = new THREE.PlaneGeometry(markerSize, markerSize);
    let mat = new THREE.MeshBasicMaterial({ map: this._generateArucoTexture(id), side: THREE.DoubleSide });
    let mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = 0.004;
    smooth.group.add(mesh);

    // Highlight frame behind the marker, shown while the camera sees it.
    // (WebGL ignores LineBasicMaterial.linewidth, so a plane reads better.)
    let haloGeo = new THREE.PlaneGeometry(markerSize * 1.18, markerSize * 1.18);
    let haloMat = new THREE.MeshBasicMaterial({ color: 0x2bd46b, side: THREE.DoubleSide });
    let halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.z = 0.002;
    halo.visible = false;
    smooth.group.add(halo);

    obj = {
      smooth, mesh, halo, geo, mat, haloGeo, haloMat, id, size: markerSize,
      hasPose: false,
      lastPose: null,
    };
    this._markerObjects[key] = obj;
    return obj;
  }

  _disposeMarker(key) {
    let obj = this._markerObjects[key];
    if (!obj) return;
    obj.geo.dispose(); obj.mat.dispose();
    obj.haloGeo.dispose(); obj.haloMat.dispose();
    obj.smooth.destroy();
    delete this._markerObjects[key];
  }

  // ── Update from topic data ─────────────────────────────────

  /**
   * Replace the markers of one source. An empty array hides that source
   * (e.g. its frame is not connected to the TF tree yet).
   * @param {Array} markers - [{ id, size, pose }] in the root frame
   * @param {string} source - topic name or any stable key
   */
  updateMarkers(markers, source = "default") {
    if (!Array.isArray(markers)) return;

    let active = new Set();
    let placed = [];

    for (let i = 0; i < markers.length; i++) {
      let m = markers[i];
      if (m == null || m.id == null) continue;
      let key = source + "|" + m.id;

      let usable = TFUtils.isPoseUsable(m.pose);
      let known = this._markerObjects[key];
      if (!usable && !(known && known.hasPose)) continue;

      let obj = this._getOrCreateMarker(key, m.id, m.size);
      if (usable) {
        obj.smooth.setTarget(m.pose.position, m.pose.orientation);
        obj.lastPose = m.pose;
        obj.hasPose = true;
      }
      // Recreated for a new size without a pose in this message: nothing to place.
      if (!obj.hasPose) continue;
      active.add(key);
      placed.push({ key, id: m.id, pose: obj.lastPose });
    }

    this._placed[source] = placed;

    for (let key in this._markerObjects) {
      if (!key.startsWith(source + "|")) continue;
      this._markerObjects[key].smooth.group.visible = this._visible && active.has(key);
    }
    this._applyDetected();
  }

  /** Ids the camera sees right now (highlighted on every source). */
  setDetected(ids) {
    this._detected = new Set(Array.from(ids || []).map(Number));
    this._applyDetected();
  }

  /** Turn the green highlight of detected markers on/off. */
  setHighlightEnabled(enabled) {
    this._highlight = !!enabled;
    this._applyDetected();
  }

  _isHighlighted(id) {
    return this._highlight && this._detected.has(Number(id));
  }

  _applyDetected() {
    for (let key in this._markerObjects) {
      let obj = this._markerObjects[key];
      obj.halo.visible = this._isHighlighted(obj.id);
    }
  }

  /** Ids currently placed by any source except the given one. */
  placedIdsExcept(source) {
    let ids = new Set();
    for (let s in this._placed) {
      if (s === source) continue;
      this._placed[s].forEach((p) => ids.add(Number(p.id)));
    }
    return ids;
  }

  // ── Labels (HTML overlay) ──────────────────────────────────

  updateLabels() {
    if (!this.labelsOverlay || !this._visible) {
      for (let key in this._labelElements) this._labelElements[key].css("display", "none");
      return;
    }

    let activeKeys = new Set();
    for (let source in this._placed) {
      let list = this._placed[source];
      for (let i = 0; i < list.length; i++) {
        let m = list[i];
        if (!m.pose || !m.pose.position) continue;
        activeKeys.add(m.key);
        let p = m.pose.position;
        let screenPos = this._project3DTo2D(p.x || 0, p.y || 0, (p.z || 0) + 0.05);
        this._setLabel(m.key, m.id, screenPos, this._isHighlighted(m.id));
      }
    }

    for (let key in this._labelElements) {
      if (!activeKeys.has(key)) {
        this._labelElements[key].remove();
        delete this._labelElements[key];
      }
    }
  }

  _project3DTo2D(x, y, z) {
    let v = new THREE.Vector3(x, y, z);
    v.project(this.camera);
    if (Math.abs(v.x) > 2 || Math.abs(v.y) > 2 || v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * 100, y: (-v.y * 0.5 + 0.5) * 100 };
  }

  _setLabel(key, id, screenPos, detected) {
    if (!screenPos) {
      if (this._labelElements[key]) this._labelElements[key].css("display", "none");
      return;
    }
    if (!this._labelElements[key]) {
      this._labelElements[key] = $('<div></div>').css({
        "position": "absolute",
        "font-family": "'JetBrains Mono', monospace",
        "white-space": "nowrap",
        "pointer-events": "none",
        "transform": "translate(-50%, -50%)",
      }).appendTo(this.labelsOverlay);
    }
    this._labelElements[key].text(String(id)).css({
      "display": "",
      "left": screenPos.x + "%",
      "top": screenPos.y + "%",
      "font-size": detected ? "11px" : "9px",
      "font-weight": detected ? "700" : "400",
      "color": detected ? "#5dff9a" : "rgba(210,220,230,0.75)",
      "text-shadow": "0 0 3px #000, 0 0 5px #000",
    });
  }

  // ── Smooth update (call every frame from render loop) ─────

  updateSmooth(dt) {
    for (let key in this._markerObjects) this._markerObjects[key].smooth.update(dt);
  }

  // ── Public API ─────────────────────────────────────────────

  setVisible(visible) {
    this._visible = !!visible;
    this.group.visible = this._visible;
    if (!this._visible) {
      for (let key in this._labelElements) this._labelElements[key].css("display", "none");
    }
  }

  destroy() {
    for (let key in this._markerObjects) this._disposeMarker(key);
    for (let id in this._textureCache) this._textureCache[id].dispose();
    this._textureCache = {};
    this.scene.remove(this.group);
    for (let key in this._labelElements) this._labelElements[key].remove();
    this._labelElements = {};
  }
}
