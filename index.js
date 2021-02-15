var http = require("http");
var sockjs = require("sockjs");
var redis = require("redis");
const fetch = require("node-fetch");

var subscriber = redis.createClient(process.env.REDIS_URL);

const API_PRODUCTION_URL = "https://api.comradery.io/v1/";

const API_DEV_URL = "http://localhost:8000/v1/";

const BASE_URL = process.env.IN_HEROKU ? API_PRODUCTION_URL : API_DEV_URL;

var connections = {};
var rooms = {};
var conn_rooms = {};
var people = {};
var conn_people = {};

const resetConn = (connId) => {
  conn_rooms[connId].forEach((room) => {
    let idx = rooms[room].indexOf(connId);
    if (idx >= 0) {
      rooms[room].splice(idx, 1);
    }
  });
  conn_rooms[connId] = [];
  if (conn_people[connId]) {
    let idx = people[conn_people[connId]].indexOf(connId);

    if (idx >= 0) {
      people[conn_people[connId]].splice(idx, 1);
    }
    conn_people[connId] = null;
  }
};

const broadcast = (channel, msg) => {
  rooms[channel].forEach((cid) => {
    connections[cid].write(msg);
  });
};

subscriber.on("message", (channel, msg) => {
  try {
    if (channel !== "system_message") {
      broadcast(channel, msg);
    } else {
      new_channel = JSON.parse(msg);
      let new_conn_ids = [];
      new_channel.members.forEach((m) => {
        if (m.id in people) {
          new_conn_ids = new_conn_ids.concat(people[m.id]);
        }
      });
      if (new_conn_ids.length > 0) {
        subscriber.subscribe(new_channel.id);

        if (new_channel.id in rooms) {
          new_conn_ids.forEach((c) => {
            if (!rooms[new_channel.id].includes(c)) {
              conn_rooms[c].push(new_channel.id);
              rooms[new_channel.id].push(c);
            }
          });
        } else {
          new_conn_ids.forEach((c) => {
            conn_rooms[c].push(new_channel.id);
          });

          rooms[new_channel.id] = new_conn_ids;
        }
      }
    }
  } catch (error) {
    Sentry.captureException(error);
  }
});

var echo = sockjs.createServer({
  sockjs_url: "http://cdn.jsdelivr.net/sockjs/1.0.1/sockjs.min.js",
});
echo.on("connection", function (conn) {
  try {
    connections[conn.id] = conn;
    conn_rooms[conn.id] = [];
  } catch (error) {
    Sentry.captureException(error);
  }
  conn.on("data", function (message) {
    try {
      msg = JSON.parse(message);
      if (msg.type === "handshake") {
        resetConn(conn.id);
        args = {};
        if (msg.token) {
          args["headers"] = { Authorization: "Token " + msg.token };
          fetch(BASE_URL + "self", args).then((data) =>
            data.json().then((data) => {
              if (data.id in people) {
                people[data.id].push(conn.id);
              } else {
                people[data.id] = [conn.id];
              }
              conn_people[conn.id] = data.id;
            })
          );
        }
        fetch(BASE_URL + `community/${msg.community_url}/chatrooms`, args).then(
          (data) =>
            data.json().then((data) => {
              data.forEach((element) => {
                subscriber.subscribe(element.id);
                conn_rooms[conn.id].push(element.id);
                if (element.id in rooms) {
                  rooms[element.id].push(conn.id);
                } else {
                  rooms[element.id] = [conn.id];
                }
              });
            })
        );
      } else if (msg.type === "keep alive") {
        return;
      }
    } catch (error) {
      Sentry.captureException(error);
    }
  });

  conn.on("close", function () {
    try {
      resetConn(conn.id);
      delete conn_rooms[conn.id];
      delete connections[conn.id];
      console.log("closed");
    } catch (error) {
      Sentry.captureException(error);
    }
  });
});

subscriber.subscribe("system_message");

var server = http.createServer();
echo.installHandlers(server, { prefix: "/thestate" });
server.listen(process.env.PORT || 8080);
