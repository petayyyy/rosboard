"use strict";

// TF Viewer v3.0
// 3D visualization for tf2_msgs/msg/TFMessage.
// Compact controls, frame labels, proper camera defaults.

class TFViewer extends Space3DViewer {
  onCreate() {
    // Storage
    this.allTransforms = {};
    this.allFrameIds = new Set();
    this.allChildFrameIds = new Set();
    this.visibleChildFrames = new Set();
    this.showLabels = true;

    // UI state
    this.selectedFrameId = null;
    this.axisScale = 0.3;
    this.showLinks = true;

    // --- Compact controls bar ---
    this.controls = $('<div></div>').css({
      "display": "flex",
      "flex-wrap": "wrap",
      "gap": "6px",
      "align-items": "center",
      "padding": "4px 0",
      "font-size": "10px",
    }).appendTo(this.card.content);

    // frame_id selector
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("frame:").appendTo(this.controls);
    this.frameIdSelect = $('<select></select>').css({
      "max-width": "120px",
      "font-size": "10px",
      "background": "#333",
      "color": "#ddd",
      "border": "1px solid #555",
      "border-radius": "3px",
      "padding": "1px 2px",
    }).appendTo(this.controls);

    // axis_scale
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("scale:").appendTo(this.controls);
    this.axisScaleInput = $('<input type="number" min="0.01" max="100" step="0.05">')
      .css({"width": "50px", "font-size": "10px", "background": "#333", "color": "#ddd", "border": "1px solid #555", "border-radius": "3px", "padding": "1px 2px"})
      .val(this.axisScale)
      .appendTo(this.controls);

    // show links checkbox
    this.showLinksLabel = $('<label></label>').css({"display": "flex", "gap": "3px", "align-items": "center", "cursor": "pointer"}).appendTo(this.controls);
    this.showLinksCheckbox = $('<input type="checkbox" checked>').appendTo(this.showLinksLabel);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("links").appendTo(this.showLinksLabel);

    // show labels checkbox
    this.showLabelsLabel = $('<label></label>').css({"display": "flex", "gap": "3px", "align-items": "center", "cursor": "pointer"}).appendTo(this.controls);
    this.showLabelsCheckbox = $('<input type="checkbox" checked>').appendTo(this.showLabelsLabel);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("labels").appendTo(this.showLabelsLabel);

    // frame count
    this.frameCountLabel = $('<span></span>').addClass("monospace").css({"opacity": 0.4, "margin-left": "auto"}).appendTo(this.controls);

    // --- Collapsible child frames panel ---
    this.childToggle = $('<div></div>').css({
      "display": "flex",
      "align-items": "center",
      "gap": "4px",
      "cursor": "pointer",
      "padding": "2px 0",
      "font-size": "10px",
      "user-select": "none",
    }).appendTo(this.card.content);

    this.childToggleArrow = $('<span></span>').text("▶").css({"opacity": 0.5, "font-size": "8px", "transition": "transform 0.2s"}).appendTo(this.childToggle);
    $('<span></span>').addClass("monospace").css({"opacity": 0.6}).text("frames").appendTo(this.childToggle);

    this.childFramesPanel = $('<div></div>').css({
      "display": "none",
      "max-height": "120px",
      "overflow-y": "auto",
      "border": "1px solid rgba(255,255,255,0.1)",
      "border-radius": "3px",
      "padding": "4px",
      "margin-bottom": "4px",
      "column-count": "2",
      "column-gap": "8px",
      "font-size": "10px",
    }).appendTo(this.card.content);

    this.childFramesList = $('<div></div>').appendTo(this.childFramesPanel);

    // Toggle handler
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
      that._updateDisplay();
    });
    this.axisScaleInput.on("change input", function() {
      let v = parseFloat($(this).val());
      if(!Number.isFinite(v) || v <= 0) v = 0.3;
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

    // Call parent (creates WebGL canvas)
    super.onCreate();

    // Override camera defaults for TF (drone-scale)
    this.cam_r = 8.0;
    this.cam_theta = -1.5707;
    this.cam_phi = 0.8;
    this.updatePerspective();

    // Update labels when camera moves (hook into render loop)
    let origUpdatePerspective = this.updatePerspective;
    let tfThis = this;
    this.updatePerspective = function() {
      origUpdatePerspective.call(tfThis);
      tfThis._updateLabels();
    };

    // Create labels overlay on top of the WebGL canvas
    this.labelsOverlay = $('<div></div>').css({
      "position": "absolute",
      "top": "0",
      "left": "0",
      "width": "100%",
      "height": "100%",
      "pointer-events": "none",
      "overflow": "hidden",
    }).appendTo(this.wrapper2);

    this.labelElements = {};
  }

  _updateFrameIdOptions() {
    let frameIds = Array.from(this.allFrameIds).sort();
    let currentValue = this.frameIdSelect.val();

    this.frameIdSelect.empty();
    if(frameIds.length === 0) {
      $('<option></option>').text("(none)").appendTo(this.frameIdSelect);
      this.selectedFrameId = null;
      return;
    }

    frameIds.forEach((fid) => {
      $('<option></option>').attr("value", fid).text(fid).appendTo(this.frameIdSelect);
    });

    if(currentValue && frameIds.includes(currentValue)) {
      this.frameIdSelect.val(currentValue);
      this.selectedFrameId = currentValue;
    } else if(!this.selectedFrameId || !frameIds.includes(this.selectedFrameId)) {
      this.selectedFrameId = frameIds.includes("map") ? "map" : frameIds[0];
      this.frameIdSelect.val(this.selectedFrameId);
    }
  }

  _updateChildFramesList() {
    let childFrames = Array.from(this.allChildFrameIds).sort();
    this.childFramesList.empty();

    if(childFrames.length === 0) return;

    if(this.visibleChildFrames.size === 0) {
      childFrames.forEach((cfid) => this.visibleChildFrames.add(cfid));
    }

    let that = this;
    childFrames.forEach((cfid) => {
      let row = $('<label></label>').css({
        "display": "flex",
        "gap": "3px",
        "align-items": "center",
        "cursor": "pointer",
        "break-inside": "avoid",
        "line-height": "1.6",
      }).appendTo(this.childFramesList);

      let checkbox = $('<input type="checkbox">')
        .prop("checked", this.visibleChildFrames.has(cfid))
        .appendTo(row);

      checkbox.on("change", function() {
        if($(this).is(":checked")) that.visibleChildFrames.add(cfid);
        else that.visibleChildFrames.delete(cfid);
        that._updateDisplay();
      });

      $('<span></span>').addClass("monospace").css({"opacity": 0.8}).text(cfid).appendTo(row);
    });

    this.frameCountLabel.text(childFrames.length + " frames");
  }

  _storeTransform(transform) {
    let parent = transform?.header?.frame_id;
    let child = transform?.child_frame_id;
    if(!parent || !child) return false;

    this.allTransforms[parent + "->" + child] = transform;

    let wasNew = !this.allFrameIds.has(parent) || !this.allChildFrameIds.has(child);
    this.allFrameIds.add(parent);
    this.allChildFrameIds.add(child);
    return wasNew;
  }

  _buildTransformTree(rootFrameId) {
    let tree = {};
    let visited = new Set();

    let buildTree = (frameId, parentPos, parentQuat) => {
      if(visited.has(frameId)) return;
      visited.add(frameId);

      let pVec = Array.isArray(parentPos)
        ? vec3.fromValues(parentPos[0], parentPos[1], parentPos[2])
        : parentPos;
      let pArr = Array.isArray(parentPos) ? parentPos : [parentPos[0], parentPos[1], parentPos[2]];

      for(let key in this.allTransforms) {
        let tf = this.allTransforms[key];
        if(tf?.header?.frame_id !== frameId) continue;

        let childId = tf?.child_frame_id;
        if(!childId) continue;

        let tr = tf?.transform?.translation;
        let rot = tf?.transform?.rotation;
        if(!tr || !rot) continue;

        let localPos = vec3.fromValues(tr.x || 0, tr.y || 0, tr.z || 0);
        let localQuat = quat.fromValues(rot.x || 0, rot.y || 0, rot.z || 0, rot.w == null ? 1 : rot.w);
        quat.normalize(localQuat, localQuat);

        let childPos = vec3.create();
        let tmp = vec3.create();
        vec3.transformQuat(tmp, localPos, parentQuat);
        vec3.add(childPos, pVec, tmp);

        let childQuat = quat.create();
        quat.multiply(childQuat, parentQuat, localQuat);

        let cArr = [childPos[0], childPos[1], childPos[2]];
        tree[childId] = {
          transform: tf,
          position: cArr,
          quaternion: childQuat,
          parentFrameId: frameId,
          parentPosition: pArr,
        };

        buildTree(childId, cArr, childQuat);
      }
    };

    buildTree(rootFrameId, [0, 0, 0], quat.fromValues(0, 0, 0, 1));
    return tree;
  }

  _renderFrameAxes(vertices, colors, position, quaternion, scale) {
    let ex = vec3.fromValues(1, 0, 0);
    let ey = vec3.fromValues(0, 1, 0);
    let ez = vec3.fromValues(0, 0, 1);
    let vx = vec3.create(), vy = vec3.create(), vz = vec3.create();

    vec3.transformQuat(vx, ex, quaternion);
    vec3.transformQuat(vy, ey, quaternion);
    vec3.transformQuat(vz, ez, quaternion);
    vec3.scale(vx, vx, scale);
    vec3.scale(vy, vy, scale);
    vec3.scale(vz, vz, scale);

    // X axis (red)
    this._pushLine(vertices, colors, position,
      [position[0]+vx[0], position[1]+vx[1], position[2]+vx[2]], [1.0, 0.2, 0.2, 1.0]);
    // Y axis (green)
    this._pushLine(vertices, colors, position,
      [position[0]+vy[0], position[1]+vy[1], position[2]+vy[2]], [0.2, 1.0, 0.2, 1.0]);
    // Z axis (blue)
    this._pushLine(vertices, colors, position,
      [position[0]+vz[0], position[1]+vz[1], position[2]+vz[2]], [0.3, 0.6, 1.0, 1.0]);
  }

  _pushLine(vertices, colors, p0, p1, rgba) {
    vertices.push(p0[0], p0[1], p0[2]);
    vertices.push(p1[0], p1[1], p1[2]);
    colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
    colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
  }

  // Project 3D point to 2D screen coordinates
  _project3DTo2D(pos3d) {
    let p = vec4.fromValues(pos3d[0], pos3d[1], pos3d[2], 1.0);
    let out = vec4.create();
    vec4.transformMat4(out, p, this.mvp);

    if(out[3] <= 0) return null; // behind camera

    let x = (out[0] / out[3] * 0.5 + 0.5);
    let y = (1.0 - (out[1] / out[3] * 0.5 + 0.5));
    return {x: x * 100, y: y * 100}; // percentage
  }

  _updateLabels() {
    if(!this.labelsOverlay) return;

    if(!this.showLabels || !this._lastTree) {
      this.labelsOverlay.css("display", "none");
      return;
    }
    this.labelsOverlay.css("display", "");

    let usedLabels = new Set();

    // Root frame label
    let rootName = this.selectedFrameId;
    if(rootName) {
      usedLabels.add(rootName);
      let screenPos = this._project3DTo2D([0, 0, 0]);
      this._setLabel(rootName, screenPos, "#fff");
    }

    // Child frame labels
    for(let childId in this._lastTree) {
      if(!this.visibleChildFrames.has(childId)) continue;
      usedLabels.add(childId);
      let pos = this._lastTree[childId].position;
      let screenPos = this._project3DTo2D(pos);
      this._setLabel(childId, screenPos, "#ccc");
    }

    // Remove unused labels
    for(let name in this.labelElements) {
      if(!usedLabels.has(name)) {
        this.labelElements[name].remove();
        delete this.labelElements[name];
      }
    }
  }

  _setLabel(name, screenPos, color) {
    if(!screenPos || screenPos.x < -10 || screenPos.x > 110 || screenPos.y < -10 || screenPos.y > 110) {
      if(this.labelElements[name]) this.labelElements[name].css("display", "none");
      return;
    }

    if(!this.labelElements[name]) {
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

  _updateDisplay() {
    if(!this.selectedFrameId) {
      this.draw([]);
      return;
    }

    let vertices = [];
    let colors = [];
    let scale = this.axisScale;
    if(!Number.isFinite(scale) || scale <= 0) scale = 0.3;

    // Root frame axes at origin
    let rootQuat = quat.fromValues(0, 0, 0, 1);
    this._renderFrameAxes(vertices, colors, [0,0,0], rootQuat, scale);

    // Build tree
    let tree = this._buildTransformTree(this.selectedFrameId);
    this._lastTree = tree;

    // Render child frames
    for(let childId in tree) {
      if(!this.visibleChildFrames.has(childId)) continue;

      let fd = tree[childId];
      this._renderFrameAxes(vertices, colors, fd.position, fd.quaternion, scale);

      if(this.showLinks) {
        this._pushLine(vertices, colors, fd.parentPosition, fd.position, [0.5, 0.5, 0.5, 0.4]);
      }
    }

    this.draw([
      {type: "lines", data: new Float32Array(vertices), colors: new Float32Array(colors)},
    ]);

    this._updateLabels();
  }

  onData(msg) {
    this._lastMsg = msg;
    this.card.title.text(msg._topic_name);

    let transforms = msg.transforms || [];
    if(!Array.isArray(transforms) || transforms.length === 0) {
      this.warn("TFMessage has no transforms[]");
      this.draw([]);
      return;
    }

    let hasNewFrames = false;
    let prevCount = this.allChildFrameIds.size;

    for(let i = 0; i < transforms.length; i++) {
      if(this._storeTransform(transforms[i])) hasNewFrames = true;
    }

    if(hasNewFrames) {
      this._updateFrameIdOptions();
      if(this.allChildFrameIds.size > prevCount) {
        this.allChildFrameIds.forEach((cfid) => this.visibleChildFrames.add(cfid));
      }
      this._updateChildFramesList();
    }

    this._updateDisplay();
  }
}

TFViewer.friendlyName = "TF (3D)";
TFViewer.supportedTypes = [
  "tf2_msgs/msg/TFMessage",
];
TFViewer.maxUpdateRate = 30.0;

Viewer.registerViewer(TFViewer);
