var ftpd = require('./ftpd.js');
var fs = require('fs');
var path = require('path');
var multiparter = require("multiparter");
var mime = require("mime");
var url = require("url");
var path = require("path");
var http = require("http");


var server = new ftpd.FtpServer("127.0.0.1", {
//    getInitialCwd: function () { return "/"; }
    getRoot: function () { return process.cwd(); },
    pasvPortRangeStart: 1025,
    pasvPortRangeEnd: 1050
});

// this event passes in the client socket which emits further events
// but should recommend they don't do socket operations on it
// so should probably encapsulate and hide it
server.on("client:connected", function(conn) {
  var username = null;
  console.log("client connected: " + conn.remoteAddress);
  conn.on("command:user", function(user, success, failure) {
      if (user) {
          username = user;
          success();
      } else failure();
  });

  conn.on("command:pass", function(pass, success, failure) {
      if (pass) success(username);
      else failure();
  });

  conn.on("file:received", function(file) {
    var post = "http://localhost/photos";
    var settings = url.parse(post);
    console.log(settings);
    var request = new multiparter.request(http, {
      host: settings.hostname,
      port: settings.post, 
      path: settings.pathname,
      method: "POST"
    });


    request.addStream(
      'file', 
      path.basename(file),
      mime.lookup(file),
      fs.statSync(file).size,
      fs.createReadStream(file));

    request.send(function(error, response) {
      if (error) {
        console.log(error);
      }

      var data = "";

      response.setEncoding("utf8");

      response.on("data", function(chunk) {
        data += chunk;
      });

      response.on("end", function() {
        console.log("Data: " + data);
      });

      response.on("error", function(error) {
        console.log(error);
      });
    });
  });
});
server.debugging = 4;
server.listen(7002);
