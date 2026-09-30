"use strict";

// rviz.html — a single full-window TFViewer: dynamic and static TF in one tree,
// ArUco maps placed by their TF frames, detections highlighted, drone model on
// base_link. Embedded by sverk-ros2-ui (RVIZ widget); also usable directly:
//   http://<drone>:8888/rviz.html            (TF from /tf + /tf_static)
//   http://<drone>:8888/rviz.html?topic=/tf  (explicit TF topic)

importJsOnce("js/viewers/meta/Viewer.js");
importJsOnce("js/viewers/plugins/SmoothTransform.js");
importJsOnce("js/viewers/plugins/TFUtils.js");
importJsOnce("js/viewers/plugins/RobotModelPlugin.js");
importJsOnce("js/viewers/plugins/ArucoDictionary.js");
importJsOnce("js/viewers/plugins/ArucoMarkerPlugin.js");
importJsOnce("js/viewers/TFViewer.js");
importJsOnce("js/transports/WebSocketV1Transport.js");

(function() {
  const params = new URLSearchParams(window.location.search);
  const TF_TOPIC = params.get("topic") || "/tf";
  const TF_TYPE = "tf2_msgs/msg/TFMessage";

  let viewer = null;
  const offline = $("#rviz-offline");

  // The card has no close/switch actions here.
  Viewer.onClose = () => {};
  Viewer.onSwitchViewer = () => {};
  Viewer._hasPrimary = (topicName) => topicName === TF_TOPIC;

  const transport = new WebSocketV1Transport({
    path: "/rosboard/v1",
    onOpen: function() {
      offline.hide();
      if (!viewer) {
        viewer = new TFViewer($("#rviz-card"), TF_TOPIC, TF_TYPE);
        window.rvizViewer = viewer; // for poking at it from the browser console
      }
      transport.subscribe({ topicName: TF_TOPIC, maxUpdateRate: 30 });
      Viewer.resubscribeSecondary();
    },
    onClose: function() {
      offline.show();
    },
    onMsg: function(msg) {
      Viewer.dispatchSecondary(msg);
      if (viewer && msg._topic_name === TF_TOPIC) viewer.update(msg);
    },
    onTopics: function(topics) {
      Viewer._topics = topics;
    },
    onSystem: function(system) {
      if (system.hostname) document.title = "RViz — " + system.hostname;
    },
  });
  Viewer._transport = transport;
  transport.connect();

  // Drone reboots / Wi-Fi drops: keep trying, like index.js does.
  // Only from CLOSED: connect() while CONNECTING would open a second socket.
  setInterval(() => {
    if (!transport.ws || transport.ws.readyState === WebSocket.CLOSED) transport.connect();
  }, 3000);
})();
