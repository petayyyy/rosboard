"use strict";

// 3D visualization for tf2_msgs/msg/TFMessage.
// Renders oriented axes for each TransformStamped in a chosen fixed frame.

class TFViewer extends Space3DViewer {
  onCreate() {
    // Add controls above the 3D canvas, then let Space3DViewer create the scene.

    this.fixedFrame = null;
    this.axisScale = 1.0;
    this.showLinks = true;

    this.controls = $('<div></div>').css({
      "display": "flex",
      "flex-wrap": "wrap",
      "gap": "8pt",
      "align-items": "center",
      "margin-bottom": "8pt",
    }).appendTo(this.card.content);

    // Fixed frame selector
    this.fixedFrameLabel = $('<div></div>')
      .addClass("monospace")
      .css({"opacity": 0.8})
      .text("fixed_frame")
      .appendTo(this.controls);

    this.fixedFrameSelect = $('<select></select>').css({
      "max-width": "220pt",
    }).appendTo(this.controls);

    // Axis scale
    this.axisScaleLabel = $('<div></div>')
      .addClass("monospace")
      .css({"opacity": 0.8})
      .text("axis_scale")
      .appendTo(this.controls);

    this.axisScaleInput = $('<input type="number" min="0.05" max="100" step="0.05"></input>')
      .css({"width": "80pt"})
      .val(this.axisScale)
      .appendTo(this.controls);

    // Links toggle
    this.showLinksLabel = $('<label></label>')
      .css({"display": "flex", "gap": "6pt", "align-items": "center"})
      .appendTo(this.controls);
    this.showLinksCheckbox = $('<input type="checkbox" checked></input>')
      .appendTo(this.showLinksLabel);
    $('<span></span>')
      .addClass("monospace")
      .css({"opacity": 0.8})
      .text("links")
      .appendTo(this.showLinksLabel);

    let that = this;
    this.fixedFrameSelect.on("change", function() {
      that.fixedFrame = $(this).val();
      if(that._lastMsg) that.onData(that._lastMsg);
    });
    this.axisScaleInput.on("change", function() {
      let v = parseFloat($(this).val());
      if(!Number.isFinite(v) || v <= 0) v = 1.0;
      that.axisScale = v;
      if(that._lastMsg) that.onData(that._lastMsg);
    });
    this.showLinksCheckbox.on("change", function() {
      that.showLinks = !!$(this).is(":checked");
      if(that._lastMsg) that.onData(that._lastMsg);
    });

    super.onCreate();
  }

  _setFixedFrameOptionsAndDefault(transforms) {
    let frames = [];
    let seen = {};
    for(let i = 0; i < transforms.length; i++) {
      let f = transforms[i]?.header?.frame_id;
      if(!f) continue;
      if(seen[f]) continue;
      seen[f] = true;
      frames.push(f);
    }
    frames.sort();

    // populate select (only if changed)
    let newKey = JSON.stringify(frames);
    if(this._lastFramesKey !== newKey) {
      this._lastFramesKey = newKey;
      this.fixedFrameSelect.empty();
      frames.forEach((f) => {
        $('<option></option>').attr("value", f).text(f).appendTo(this.fixedFrameSelect);
      });
    }

    // choose default fixed frame
    if(!this.fixedFrame || !seen[this.fixedFrame]) {
      if(seen["map"]) this.fixedFrame = "map";
      else if(frames.length > 0) this.fixedFrame = frames[0];
      else this.fixedFrame = null;
    }
    if(this.fixedFrame) this.fixedFrameSelect.val(this.fixedFrame);
  }

  _pushLine(vertices, colors, p0, p1, rgba) {
    vertices.push(p0[0], p0[1], p0[2]);
    vertices.push(p1[0], p1[1], p1[2]);
    // per-vertex color (same for both endpoints)
    colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
    colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
  }

  onData(msg) {
    this._lastMsg = msg;
    this.card.title.text(msg._topic_name);

    let transforms = msg.transforms || [];
    if(!Array.isArray(transforms) || transforms.length === 0) {
      this.warn("TFMessage has no transforms[]");
      this.draw([]); // still show grid/axes
      return;
    }

    this._setFixedFrameOptionsAndDefault(transforms);
    if(!this.fixedFrame) {
      this.warn("No header.frame_id found in transforms[]");
      this.draw([]);
      return;
    }

    let vertices = [];
    let colors = [];

    // Base axes (unit vectors)
    let ex = vec3.fromValues(1, 0, 0);
    let ey = vec3.fromValues(0, 1, 0);
    let ez = vec3.fromValues(0, 0, 1);

    let vx = vec3.create();
    let vy = vec3.create();
    let vz = vec3.create();

    let scale = this.axisScale;
    if(!Number.isFinite(scale) || scale <= 0) scale = 1.0;

    let origin = [0, 0, 0];

    let shown = 0;
    for(let i = 0; i < transforms.length; i++) {
      let t = transforms[i];
      let parent = t?.header?.frame_id;
      if(parent !== this.fixedFrame) continue;

      let tr = t?.transform?.translation;
      let rot = t?.transform?.rotation;
      if(!tr || !rot) continue;

      let p = [tr.x || 0, tr.y || 0, tr.z || 0];
      let q = quat.fromValues(rot.x || 0, rot.y || 0, rot.z || 0, rot.w == null ? 1 : rot.w);
      quat.normalize(q, q);

      vec3.transformQuat(vx, ex, q);
      vec3.transformQuat(vy, ey, q);
      vec3.transformQuat(vz, ez, q);
      vec3.scale(vx, vx, scale);
      vec3.scale(vy, vy, scale);
      vec3.scale(vz, vz, scale);

      // Oriented triad at p
      this._pushLine(vertices, colors, p, [p[0] + vx[0], p[1] + vx[1], p[2] + vx[2]], [1.0, 0.2, 0.2, 1.0]); // X red
      this._pushLine(vertices, colors, p, [p[0] + vy[0], p[1] + vy[1], p[2] + vy[2]], [0.2, 1.0, 0.2, 1.0]); // Y green
      this._pushLine(vertices, colors, p, [p[0] + vz[0], p[1] + vz[1], p[2] + vz[2]], [0.2, 0.6, 1.0, 1.0]); // Z cyan

      // Optional link from fixed-frame origin to this transform
      if(this.showLinks) {
        this._pushLine(vertices, colors, origin, p, [0.7, 0.7, 0.7, 0.6]);
      }

      shown++;
    }

    if(shown === 0) {
      this.warn("No transforms with header.frame_id == " + this.fixedFrame);
      this.draw([]);
      return;
    }

    this.draw([
      {type: "lines", data: new Float32Array(vertices), colors: new Float32Array(colors)},
    ]);
  }
}

TFViewer.friendlyName = "TF (3D)";
TFViewer.supportedTypes = [
  "tf2_msgs/msg/TFMessage",
];
TFViewer.maxUpdateRate = 30.0;

Viewer.registerViewer(TFViewer);

