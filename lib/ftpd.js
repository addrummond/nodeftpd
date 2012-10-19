var net = require('net');
var util = require('util');
var events = require('events');
var PathModule = require('path');
var FsModule = require('fs');
var glob = require('./glob');
var tls = require('tls');
var crypto = require('crypto');
var starttls = require('./starttls');
var dateformat = require('dateformat');
var constants = require('constants');

/*
TODO:
- Implement Full RFC 959
- Implement Full RFC 2228 [PBSZ and PROT implemented already]
- Implement RFC 3659

- passive command is for server to determine which port it listens on and report that to the client
- doesn't necessarily mean it needs to be listening (i guess), but i assume it actually SHOULD be listening
- it keeps listening for subsequent connections

- what sort of security should i enforce? should i require the same IP for data and control connections?
    - maybe just for milesplit's use?
*/

function withCwd(cwd, p) {
    if (! p) return cwd;
    else if (! cwd) return p;
    else if (p.charAt(0) == "/") return p;
    else return PathModule.join(cwd, p);
}

// Currently used for stripping options from beginning of argument to LIST and NLST.
function stripOptions(str) {
    var IN_SPACE = 0, IN_DASH = 1;
    var state = IN_SPACE;
    for (var i = 0; i < str.length; ++i) {
        var c = str.charAt(i);
        if (state == IN_SPACE) {
            if (c == ' ' || c == '\t')
                ;
            else if (c == '-')
                state = IN_DASH;
            else
                return str.substr(i);
        }
        else if (state == IN_DASH && (c == ' ' || c == '\t')) {
            state = IN_SPACE;
        }
    }
    return "";
}

function PassiveListener() {
    events.EventEmitter.call(this);
}
util.inherits(PassiveListener, process.EventEmitter);

// We don't want to use setEncoding because it screws up TLS, but we
// also don't want to explicity specify ASCII encoding for every call to 'write'
// with a string argument.
function wwenc(socket, data, callback) {
    return socket.write(data, 'ascii', callback);
}

function FtpServer(host, options) {
    var self = this;
    events.EventEmitter.call(self);

    self.host = host;

    self.options = options;
    if (! self.options.maxStatsAtOnce)
	self.options.maxStatsAtOnce = 5;

    self.server = net.createServer();
    self.getInitialCwd = options.getInitialCwd || function () { return "/"; };
    self.getUsernameFromUid = options.getUsernameFromUid || function (uid, c) { c(null, "ftp"); };
    self.getGroupFromGid = options.getGroupFromGid || function (gid, c) { c(null, "ftp"); }
    self.getRoot = options.getRoot || function () { return "/"; };
    self.debugging = options.logLevel || 0;
    self.uploadMaxSlurpSize = options.uploadMaxSlurpSize || 0;

    self.server.on('connection', function (socket) { self._onConnection(socket); });
    self.server.on('error', function (err) { self.emit('error', err); });
    self.server.on('close', function () { self.emit('close'); });
}
util.inherits(FtpServer, process.EventEmitter);

FtpServer.prototype._onConnection = function (socket) {
    var conn = new FtpConnection({
        server: this,
        socket: socket,
        pasv: null, // passive listener server
        dataPort: 20,
        dataHost: null,
        dataListener: null, // for incoming passive connections
        dataSocket: null, // the actual data socket
        // True if the client has sent a PORT/PASV command, and
        // we haven't experienced a problem with the configuration
        // it specified. (This can therefore be true even if there
        // is not currently an open data connection.
        dataConfigured: false,
        mode: "ascii",
        filefrom: "",
        authFailures: 0, // 3 tries then we disconnect you
        username: null,
        filename: "",
        fs: null,
        cwd: null,
        root: null,
        hasQuit: false,
        
        // State for handling TLS upgrades.
        secure: false,
        pbszReceived: false
    });

    this.emit("client:connected", conn); // pass client info so they can listen for client-specific events

    socket.setTimeout(0);
    socket.setNoDelay();

    socket.on('connect', function () { conn._onConnect(); });
    socket.on('data', function (buf) { conn._onData(buf); });
    socket.on('end', function () { conn._onEnd(); });
    socket.on('close', function () { conn._onClose(); });
    socket.on('error', function (err) { conn._onError(err); });
};

["listen", "close"].forEach(function (fname) {
    FtpServer.prototype[fname] = function () {
        return this.server[fname].apply(this.server, arguments);
    }
});

FtpServer.prototype._logIf = function (level, message, conn, isError) {
    if (this.debugging >= level) {
        if (conn)
            console.log((conn & conn.socket ? conn.socket.remoteAddress + ": " : "") + message);
        else
            console.log(message);
        
        if (isError) {
            console.trace("Trace follows");
        }
    }
};
FtpServer.prototype._traceIf = function (level, message, conn) { return this._logIf(level, message, conn, true); };

function FtpConnection(properties) {
    events.EventEmitter.call(this);
    for (k in properties) { this[k] = properties[k]; }
}
util.inherits(FtpConnection, process.EventEmitter);

FtpConnection.prototype._logIf = function (level, message, conn, isError) { return this.server._logIf(level, message, this, isError); };
FtpConnection.prototype._traceIf = function (level, message, conn) { return this.server._traceIf(level, message, this); };

FtpConnection.prototype._authenticated = function () {
    return !!this.username;
};

FtpConnection.prototype._authFailures = function () {
    if (this.authFailures >= 2) {
        this.socket.end();
        return true;
    }
    return false;
};

FtpConnection.prototype._closeDataConnections = function () {
    if (this.dataSocket)
        this.dataSocket.destroy();
    if (this.pasv)
        this.pasv.close();
};

FtpConnection.prototype._createPassiveServer = function () {
    var self = this;

    return net.createServer(function (psocket) {
        self._logIf(1, "Passive data event: connect");

        if (self.secure) {
            self._logIf(1, "Upgrading passive connection to TLS");
            starttls.starttlsServer(psocket, self.server.options.tlsOptions, function (err, cleartext) {
                if (err) {
                    self._logIf(0, "Error upgrading passive connection to TLS:" + util.inspect(err));
                    psocket.end();
                    self.dataConfigured = false;
                }
                else if (! cleartext.authorized) {
                    if (self.server.options.allowUnauthorizedTls) {
                        self._logIf(0, "Allowing unauthorized passive connection (allowUnauthorizedTls==true)");
                        switchToSecure();
                    }
                    else {
                        self._logIf(0, "Closing unauthorized passive connection (allowUnauthorizedTls==false)");
                        self.socket.end();
                        self.dataConfigured = false;
                    }
                }
                else {
                    switchToSecure();
                }
                
                function switchToSecure() {
                    self._logIf(1, "Secure passive connection started");
                    self.dataSocket = cleartext;
                    setupPassiveListener();
                }
            });
        }
        else {
            self.dataSocket = psocket;
            setupPassiveListener();
        }

        function setupPassiveListener() {
            if (self.dataListener)
                self.dataListener.emit('ready');
            else
                self._logIf(0, "WARNING: Passive connection initiated, but no data listener");

            // Responses are not guaranteed to have an 'end' event
            // (https://github.com/joyent/node/issues/728), but we want to set
            // dataSocket to null as soon as possible, so we handle both events.
            self.dataSocket.on('close', allOver('close'));
            self.dataSocket.on('end', allOver('end'));
            function allOver(ename) {
                return function (err) {
                    self._logIf(
                        (err ? 0 : 3),
                        "Passive data event: " + ename + (err ? " due to error" : "")
                    );
                    self.dataSocket = null;
                };
            }
            self.dataSocket.on("error", function(err) {
                self._logIf(0, "Passive data event: error: " + err);
                self.dataSocket = null;
                self.dataConfigured = false;
            });
        }
    });
};

FtpConnection.prototype._whenDataReady = function (callback) {
    var self = this;

    if (self.dataListener) {
        // how many data connections are allowed?
        // should still be listening since we created a server, right?
        if (self.dataSocket) {
            self._logIf(3, "A data connection exists");
            callback(self.dataSocket);
        } else {
            self._logIf(3, "Currently no data connection; expecting client to connect to pasv server shortly...");
            self.dataListener.once('ready', function () {
                self._logIf(3, "...client has connected now");
                callback(self.dataSocket);
            });
        }
    } else {
        // Do we need to open the data connection?
        if (self.dataSocket) { // There really shouldn't be an existing connection
            self._logIf(3, "Using existing non-passive dataSocket");
            callback(self.dataSocket);
        } else {
            self._initiateData(function (sock) {
                callback(sock);
            });
        }
    }
};

FtpConnection.prototype._initiateData = function (callback) {
    var self = this;

    if (self.dataSocket)
        return callback(self.dataSocket);

    var sock = net.connect(self.dataPort, self.dataHost || self.socket.remoteAddress);
    sock.on('connect', function () {
        self.dataSocket = sock;
        callback(sock);
    });
    sock.on('end', allOver);
    sock.on('close', allOver);
    function allOver(err) {
        self.dataSocket = null;
        self._logIf(err ? 0 : 3, "Non-passive data connection ended" + (err ? "due to error: " + util.inspect(e) : ""));
    }
    sock.on('error', function (err) {
        sock.destroy();
        self._logIf(0, "Data connection error: " + util.inspect(err));
        self.dataSocket = null;
        self.dataConfigured = false;
    });
};

FtpConnection.prototype._onError = function (err) {
    this._logIf(0, "Client connection error: " + util.inspect(err));
    this.socket.destroy();
};

FtpConnection.prototype._onEnd = function () {
    this._logIf(3, "Client connection ended");
};

FtpConnection.prototype._onClose = function () {
    this._logIf(0, "Client connection closed");
};

FtpConnection.prototype._onConnect = function () {
    this._logIf(1, "Connection");
    wwenc(this.socket, "220 FTP server (nodeftpd) ready\r\n");
};

var NOT_SUPPORTED = { }; // (But recognized)
[ 'ABOR', 'ACCT', 'ADAT', 'ALLO', 'APPE', 'CCC',
  'CONF', 'ENC', 'HELP', 'LANG', 'LPRT', 'LPSV',
  'MDTM', 'MIC', 'MLSD', 'MLST', 'MODE', 'OPTS',
  'REIN', 'SITE', 'SMNT', 'STOU', 'STRU', 'SYST'
].forEach(function (ns) { NOT_SUPPORTED[ns] = true; });

// Whitelist of commands which don't require authentication.
// All other commands sent by unauthorized users will be rejected by default.
var DOES_NOT_REQUIRE_AUTH = { };
[ 'AUTH', 'FEAT', 'NOOP', 'PASS', 'PBSZ', 'PROT', 'QUIT',
  'TYPE', 'USER'
].forEach(function (c) { DOES_NOT_REQUIRE_AUTH[c] = true; });

// Commands which can't be issued until a PASV/PORT command has been sent
// without an intervening data connection error.
var REQUIRES_CONFIGURED_DATA = { };
[ 'LIST', 'NLST', 'RETR', 'STOR' ]
.forEach(function (c) { REQUIRES_CONFIGURED_DATA[c] = true; });
                    
FtpConnection.prototype._onData = function (data) {
    var self = this;

    if (self.hasQuit)
        return;

    data = data.toString('utf-8').trim();
    // Don't want to include passwords in logs.
    self._logIf(2, "FTP command: " + data.toString('utf-8').replace(/^PASS\s+.*/, 'PASS ***'));

    var command, arg;
    var index = data.indexOf(" ");
    if (index > 0) {
        command = data.substring(0, index).trim().toUpperCase();
        commandArg = data.substring(index+1, data.length).trim();
    } else {
        command = data.trim().toUpperCase();
        commandArg = '';
    }

    var m = '_command_' + command;
    if (self[m]) {
        if (DOES_NOT_REQUIRE_AUTH[command]) {
            self[m](commandArg, command);
        }
        else {
            // If 'tlsOnly' option is set, all commands which require user authentication will only
            // be permitted over a secure connection. See RFC4217 regarding error code.
            if (!self.secure && self.server.options.tlsOnly)
                wwenc(self.socket, "522 Protection level not sufficient; send AUTH TLS\r\n");
            else if (self._authenticated())
                checkData();
            else
                wwenc(self.socket, "530 User not logged in\r\n");
        }

        function checkData() {
            if (REQUIRES_CONFIGURED_DATA[command] && !self.dataConfigured) {
                wwenc(self.socket, "425 Data connection not configured; send PASV or PORT\r\n");
                return;
            }

            self[m](commandArg, command);
        }
    }
    else if (NOT_SUPPORTED[command]) {
        wwenc(self.socket, "202 Not supported\r\n");
    }
    else {
        wwenc(self.socket, "202 Not recognized\r\n");
    }
};

FtpConnection.prototype._command_AUTH = function (commandArg) {
    var self = this;

    if (! self.server.options.tlsOptions)
        return wwenc(self.socket, "202 Not supported\r\n");
    if (commandArg != "TLS")
        return wwenc(self.socket, "500 Not recognized\r\n");
    
    wwenc(self.socket, "234 Honored\r\n", function () {
        self._logIf(0, "Establishing secure connection...");
        starttls.starttlsServer(self.socket, self.server.options.tlsOptions, function (err, cleartext) {
            if (err) {
                self._logIf(0, "Error upgrading connection to TLS: " + util.inspect(err));
                self.socket.end();
            }
            else if (! cleartext.authorized) {
                self._logIf(0, "Secure socket not authorized: " + util.inspect(cleartext.authorizationError));
                if (self.server.options.allowUnauthorizedTls) {
                    self._logIf(0, "Allowing unauthorized connection (allowUnauthorizedTls==true)");
                    switchToSecure();
                }
                else {
                    self._logIf(0, "Closing unauthorized connection (allowUnauthorizedTls==false)");
                    sekf.socket.end();
                }
            }
            else {
                switchToSecure();
            }
            
            function switchToSecure() {
                self._logIf(1, "Secure connection started");
                self.socket = cleartext;
                self.socket.on('data', function (data) { self._onData(data); });
                self.secure = true;
            }
        });
    });
};

FtpConnection.prototype._command_CDUP = function (commandArg)  {
    // Change to Parent Directory.
    // Not sure if this is technically correct, but 'dirname' does in fact just
    // strip the last component of the path for a UNIX-style path, even if this
    // has a trailing slash. It also maps "/foo" to "/" and "/" to "/".
    this.cwd = PathModule.dirname(this.cwd);
    wwenc(this.socket, "250 Directory changed to " + this.cwd + "\r\n");
};

FtpConnection.prototype._command_CWD = function (commandArg) {
    var self = this;

    var path = withCwd(self.cwd, commandArg);
    var fspath = PathModule.join(self.root, path);
    self.fs.stat(fspath, function(err, stats) {
        if (err) {
            if (err.code == 'ENOENT')
                self._logIf(0, "Error other than ENOENT in call to 'stat'" + err);
            wwenc(self.socket, "550 Folder not found.\r\n");
        }
        else if (! stats.isDirectory()) {
            self._logIf(3, "Attempt to CWD to non-directory\r\n");
            wwenc(self.socket, "550 Not a directory\r\n");
        }
        else {
            self.cwd = path;
            wwenc(self.socket, "250 CWD successful. \"" + self.cwd + "\" is current directory\r\n");
        }
    });
};

FtpConnection.prototype._command_DELE = function (commandArg) {
    var self = this;

    var filename = withCwd(self.cwd, commandArg);
    self.fs.unlink( PathModule.join(self.root, filename), function(err){
        if (err) {
            self._logIf(0, "Error deleting file: " + filename + ", " + err);
            // write error to socket
            wwenc(self.socket, "550 Permission denied\r\n");
        } else {
            wwenc(self.socket, "250 File deleted\r\n");
        }
    });
};

FtpConnection.prototype._command_FEAT = function (commandArg) {
    // Get the feature list implemented by the server. (RFC 2389)
    wwenc(
        this.socket,
        "211-Features\r\n" +
        " SIZE\r\n" +
        (!this.server.options.tlsOptions ? "" :
            " AUTH TLS\r\n" +
            " PBSZ\r\n" +
            " PROT\r\n"
        ) +
        "211 end\r\n"
    );
};

FtpConnection.prototype._command_LIST = function (x, y) { this._LIST(x, true/*detailed*/); };
FtpConnection.prototype._command_NLST = function (x, y) { this._LIST(x, false/*!detailed*/); };
FtpConnection.prototype._LIST = function (commandArg, detailed) {
    /*
      Normally the server responds with a mark using code 150. It then stops accepting new connections, attempts to send the contents of the directory over the data connection, and closes the data connection. Finally it
      
      accepts the LIST or NLST request with code 226 if the entire directory was successfully transmitted;
      rejects the LIST or NLST request with code 425 if no TCP connection was established;
      rejects the LIST or NLST request with code 426 if the TCP connection was established but then broken by the client or by network failure; or
      rejects the LIST or NLST request with code 451 if the server had trouble reading the directory from disk.
      
      The server may reject the LIST or NLST request (with code 450 or 550) without first responding with a mark. In this case the server does not touch the data connection.
    */

    var self = this;

    // LIST may be passed options (-a in particular). We just ignore any of these.
    // (In the particular case of -a, we show hidden files anyway.)
    var dirname = stripOptions(commandArg);
    var dir = withCwd(self.cwd, dirname);

    glob.setMaxStatsAtOnce(self.server.options.maxStatsAtOnce);
    glob.glob(PathModule.join(self.root, dir), self.fs, function (err, files) {
        if (err) {
            self._logIf(0, "While sending file list, reading directory: " + err);
            wwenc(self.socket, "550 Not a directory\r\n");
            pasvconn.end();
	    return;
        }

        self._logIf(3, "Directory has " + files.length + " files");
        if (files.length == 0)
            return self._listFiles([]);

        var fileInfos; // To contain list of files with info for each.

        if (! detailed) {
            // We're not doing a detailed listing, so we don't need to get username
            // and group name.
            fileInfos = files;
            return finished();
        }
        
        // Now we need to get username and group name for each file from user/group ids.
        fileInfos = [];
        
        var CONC = self.server.options.maxStatsAtOnce;
        var i = 0, j = 0;
        for (i = 0; i < files.length && i < CONC; ++i)
            handleFile(i);
        j = --i;
        
        function handleFile(ii) {
            if (i >= files.length)
                return i == files.length + j ? finished() : null;
            
            self.server.getUsernameFromUid(files[ii].stats.uid, function (e1, uname) {
            self.server.getGroupFromGid(files[ii].stats.gid, function (e2, gname) {
                if (e1 || e2) {
                    self._logIf(3, "Error getting user/group name for file: " + util.inspect(e1 || e2));
                    fileInfos.push({ file: files[ii],
                                     uname: null,
                                     gname: null });
                }
                else {
                    fileInfos.push({ file: files[ii],
                                     uname: uname,
                                     gname: gname });
                }
                handleFile(++i);
            });});
        }
        
        function finished() {
            // Sort file names.
            if (! self.server.options.dontSortFilenames) {
                if (self.server.options.filenameSortMap !== false) {
                    var sm = ( self.server.options.filenameSortMap ||
                               function (x) { return x.toUpperCase(); } );
                    for (var i = 0; i < fileInfos.length; ++i)
                        fileInfos[i]._s = sm(detailed ? fileInfos[i].file.name : fileInfos[i].name);
                }

                var sf = (self.server.options.filenameSortFunc ||
                          function (x, y) { return x.localeCompare(y); });
                fileInfos = fileInfos.sort(function (x, y) {
                    if (self.server.options.filenameSortMap !== false)
                        return sf(x._s, y._s);
                    else if (detailed)
                        return sf(x.file.name, y.file.name);
                    else
                        return sf(x.name, y.name);
                });
            }
            
            self._listFiles(fileInfos, detailed);
        }
    }, self.server.options.noWildcards);
};

function leftPad(text, width) {
    var out = '';
    for (var j = text.length; j < width; j++) out += ' ';
    out += text;
    return out;
}

FtpConnection.prototype._listFiles = function (fileInfos, detailed) {
    var self = this;

    wwenc(self.socket, "150 Here comes the directory listing\r\n", function () {
        self._whenDataReady(function(pasvconn) {
            if (fileInfos.length == 0)
                return success();

            function success (err) {
                if (err)
                    wwenc(self.socket, "550 Error listing files");
                else
                    wwenc(self.socket, "226 Transfer OK\r\n");
                pasvconn.end();
            }

            self._logIf(3, "Sending file list");
            
            for (var i = 0; i < fileInfos.length; ++i) {
                var fileInfo = fileInfos[i];

                var line;

                if (! detailed) {
                    var file = fileInfo;
                    line = file.name + "\r\n";
                }
                else {
                    var file = fileInfo.file;
                    line = "";
                    var s = file.stats;
                    line = s.isDirectory() ? 'd' : '-';
                    line += (0400 & s.mode) ? 'r' : '-';
                    line += (0200 & s.mode) ? 'w' : '-';
                    line += (0100 & s.mode) ? 'x' : '-';
                    line += (040 & s.mode) ? 'r' : '-';
                    line += (020 & s.mode) ? 'w' : '-';
                    line += (010 & s.mode) ? 'x' : '-';
                    line += (04 & s.mode) ? 'r' : '-';
                    line += (02 & s.mode) ? 'w' : '-';
                    line += (01 & s.mode) ? 'x' : '-';
                    line += " 1 " + (fileInfo.uname === null ? "ftp" : fileInfo.uname) + " " +
                            (fileInfo.gname === null ? "ftp" : fileInfo.gname) + " ";
                    line += leftPad(s.size.toString(), 12) + ' ';
                    var d = new Date(s.mtime);
                    line += leftPad(dateformat(d, 'mmm dd HH:MM'), 12) + ' ';
                    line += file.name;
                    line += '\r\n';
                }

                wwenc(pasvconn, line, (i == fileInfos.length - 1 ? success : undefined));
            }
        });
    });
};

FtpConnection.prototype._command_MKD = function (commandArg) {
    var self = this;

    var filename = withCwd(self.cwd, commandArg);
    self.fs.mkdir( PathModule.join(self.root, filename), 0755, function(err){
        if(err) {
            self._logIf(0, "Error making directory " + filename + " because " + err);
            // write error to socket
            wwenc(self.socket, "550 \"" + filename + "\" directory NOT created\r\n");
            return;
        }
        wwenc(self.socket, "257 \"" + filename + "\" directory created\r\n");
    });
};

FtpConnection.prototype._command_NOOP = function () {
    // No operation (dummy packet; used mostly on keepalives).
    wwenc(this.socket, "200 OK\r\n");
};

FtpConnection.prototype._command_PORT = function (x, y) { this._PORT(x, y); };
FtpConnection.prototype._command_EPRT = function (x, y) { this._PORT(x, y); };
FtpConnection.prototype._PORT = function (commandArg, command) {
    var self = this;

    self.dataConfigured = false;

    var host, port;
    if (command == 'PORT') {
        var m = commandArg.match(/^([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3})$/);
        if (! m) {
            wwenc(self.socket, "501 Bad argument to PORT\r\n");
            return;
        }
        
        var host = m[1] + '.' + m[2] + '.' + m[3] + '.' + m[4];
        var port = (parseInt(m[5]) << 8) + parseInt(m[6]);
        if (isNaN(port))
            throw new Error("Impossible NaN in FtpConnection.prototype._PORT");
    }
    else { // EPRT
        if (commandArg.length >= 3 && commandArg.charAt(0) == '|' &&
            commandArg.charAt(2) == '|' && commandArg.charAt(1) == '2') {
            // Only IPv4 is supported.
            wwenc(self.socket, "522 Server cannot handle IPv6 EPRT commands, use (1)\r\n");
            return;
        }

        var m = commandArg.match(/^\|1\|([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\|([0-9]{1,5})/);
        if (! m) {
            wwenc(self.socket, "501 Bad Argument to EPRT\r\n");
            return;
        }

        var r = parseInt(m[3]);
        if (isNaN(r))
            throw new Error("Impossible NaN in FtpConnection.prototype._PORT (2)");
        if (r > 65535 || r <= 0) {
            wwenc(self.socket, "501 Bad argument to EPRT (invalid port number)\r\n");
            return;
        }

        host = m[1];
        port = r;
    }

    self.dataConfigured = true;
    self.dataHost = host;
    self.dataPort = port;
    self._logIf(3, "self.dataHost, self.dataPort set to " + self.dataHost + ":" + self.dataPort);
    wwenc(self.socket, "200 OK\r\n");
};

FtpConnection.prototype._command_PASV = function (x, y) { this._PASV(x, y); };
FtpConnection.prototype._command_EPSV = function (x, y) { this._PASV(x, y); };
FtpConnection.prototype._PASV = function (commandArg, command) {
    var self = this;

    self.dataConfigured = false;

    if (command == "EPSV" && commandArg && commandArg != "1") {
        wwenc(self.socket, "202 Not supported\r\n");
        return;
    }

    // not sure whether the spec limits to 1 data connection at a time ...
    if (self.dataSocket) {
        self.dataSocket.end();
    }

    if (self.dataListener) {
        self._logIf(3, "Telling client that they can connect now");
        self._writePASVReady(command);
    }
    else {
        self._logIf(3, "Setting up listener for passive connections");
        self._setupNewPASV(commandArg, command);
    }

    self.dataConfigured = true;
};

FtpConnection.prototype._writePASVReady = function (command) {
    var self = this;

    var a = self.pasv.address();
    var host = self.server.host;
    var port = a.port;
    if (command == "PASV") {
        var i1 = (port / 256)|0;
        var i2 = port % 256;
        wwenc(self.socket, "227 Entering Passive Mode (" + host.split(".").join(",") + "," + i1 + "," + i2 + ")\r\n");
    }
    else { // EPASV
        wwenc(self.socket, "229 Entering Extended Passive Mode (|||" + port + "|)\r\n");
    }
};

FtpConnection.prototype._setupNewPASV = function (commandArg, command) {
    var self = this;

    var pasv = self._createPassiveServer();
    var portRangeErrorHandler;
    function normalErrorHandler(e) {
        self._logIf(3, "Error with passive data listener: " + util.inspect(e));
        wwenc(self.socket, "421 Server was unable to open passive connection listener\r\n");
        self.dataConfigured = false;
        self.dataListener = null;
        self.dataSocket = null;
        self.pasv = null;
    }
    if (self.server.options.pasvPortRangeStart != null && self.server.options.pasvPortRangeEnd != null) {
        // Keep trying ports in the range supplied until either:
        //     (i)   It works
        //     (ii)  We get an error that's not just EADDRINUSE
        //     (iii) We run out of ports to try.
        var i = self.server.options.pasvPortRangeStart;
        pasv.listen(i);
        portRangeErrorHandler = function (e) {            
            if (e.code == 'EADDRINUSE' && i < self.server.options.pasvPortRangeEnd) {
                pasv.listen(++i);
            }
            else {
                self._logIf(3, "Passing on error from portRangeErrorHandler to normalErrorHandler:" + JSON.stringify(e));
                normalErrorHandler(e);
            }
        };
        pasv.on('error', portRangeErrorHandler);
    }
    else {
        pasv.listen(0);
        pasv.on('error', normalErrorHandler);
    }

    // Once we're successfully listening, tell the client
    pasv.on("listening", function() {
        self.pasv = pasv;

        if (portRangeErrorHandler) {
            pasv.removeListener('error', portRangeErrorHandler);
            pasv.addListener('error', normalErrorHandler);
        }

        self._logIf(3, "Passive data connection beginning to listen");

        var port = pasv.address().port;
        var host = self.server.host;
        self.dataListener = new PassiveListener();
        self._logIf(3, "Passive data connection listening on port " + port);
        self._writePASVReady(command);
    });
    pasv.on("close", function() {
        self.pasv = null;
        self.dataListener = null;
        self._logIf(3, "Passive data listener closed");
    });
};

FtpConnection.prototype._command_PBSZ = function (commandArg) {
    var self = this;

    if (! self.server.options.tlsOptions)
        return wwenc(socket, "202 Not supported\r\n");
    
    // Protection Buffer Size (RFC 2228)
    if (! self.secure) {
        wwenc(self.socket, "503 Secure connection not established\r\n");
    }
    else if (parseInt(commandArg) != 0) {
        // RFC 2228 specifies that a 200 reply must be sent specifying a more
        // satisfactory PBSZ size (0 in our case, since we're using TLS).
        // Doubt that this will do any good if the client was already confused
        // enough to send a non-zero value, but ok...
        self.pbszReceived = true;
        wwenc(self.socket, "200 buffer too big, PBSZ=0\r\n");
    }
    else {
        self.pbszReceived = true;
        wwenc(self.socket, "200 OK\r\n");
    }
};

FtpConnection.prototype._command_PROT = function (commandArg) {
    var self = this;

    if (! self.server.options.tlsOptions)
        return wwenc(self.socket, "202 Not supported\r\n");
    
    if (! self.pbszReceived) {
        wwenc(self.socket, "503 No PBSZ command received\r\n");
    }
    else if (commandArg == 'S' || commandArg == 'E' || commandArg == 'C') {
        wwenc(self.socket, "536 Not supported\r\n");
    }
    else if (commandArg == 'P') {
        wwenc(self.socket, "200 OK\r\n");
    }
    else {
        // Don't even recognize this one...
        wwenc(self.socket, "504 Not recognized\r\n");
    }
};

FtpConnection.prototype._command_PWD = function (commandArg) {
    // Print working directory. Returns the current directory of the host.
    wwenc(this.socket, "257 \"" + this.cwd + "\" is current directory\r\n");
};

FtpConnection.prototype._command_QUIT = function (commandArg) {
    var self = this;

    self.hasQuit = true;
    wwenc(self.socket, "221 Goodbye\r\n", function (err) {
        if (err)
            self._logIf(0, "Error writing 'Goodbye' message following QUIT");
        self.socket.end();
        self._closeDataConnections();
    });
};

FtpConnection.prototype._command_RETR = function (commandArg) {
    var self = this;

    function afterOk(callback) {
        wwenc(self.socket, "150 Opening " + self.mode.toUpperCase() + " mode data connection\r\n", callback);
    }

    // Retrieve (download) a remote file.
    var filename = PathModule.join(self.root, withCwd(self.cwd, commandArg));
    
    if (self.server.options.slurpFiles) {
        self.fs.readFile(filename, function (err, contents) {
            if (err) {
                if (err.code == 'ENOENT') {
                    wwenc(self.socket, "550 Not Found\r\n");
                }
                else { // Who knows what's going on here...
                    wwenc(self.socket, "550 Not Accessible\r\n");
                    self._traceIf(0, "Error at read of '" + filename + "' other than ENOENT " + err, self);
                }
            }
            else {
                afterOk(function () {
                    self._whenDataReady(function (pasvconn) {
                        pasvconn.write(contents);
                        wwenc(self.socket, "226 Closing data connection, sent " + contents.length + " bytes\r\n");
                        pasvconn.end();
                    });
                });
            }
        });
    }
    else {
        self.fs.open(filename, "r", function (err, fd) {
            if(err) {
                if (err.code == 'ENOENT') {
                    wwenc(self.socket, "550 Not Found\r\n");
                }
                else { // Who know's what's going on here...
                    wwenc(self.socket, "550 Not Accessible\r\n");
                    self._traceIf(0, "Error at read other than ENOENT " + err, self);
                }
            }
            else {
                self._logIf(0, "DATA file " + filename + " opened");
                afterOk(function () {
                    readChunk();
                });
            }
            
            var totsize = 0;
            function readChunk() {
                self._whenDataReady(function (pasvconn) {
                    if (! self.buffer) self.buffer = new Buffer(4096);
                    self.fs.read(fd, self.buffer, 0, 4096, null/*pos*/, function(err, bytesRead, buffer) {
                        if(err) {
                            self._traceIf(0, "Error reading chunk", self);
                            self.server.emit("error", err);
                            return;
                        }
                        if (bytesRead > 0) {
                            totsize += bytesRead;
                            if(pasvconn.readyState == "open") pasvconn.write(self.buffer.slice(0, bytesRead));
                            readChunk();
                        }
                        else {
                            self._logIf(0, "DATA file " + filename + " closed");
                            wwenc(self.socket, "226 Closing data connection, sent " + totsize + " bytes\r\n");
                            pasvconn.end();
                            self.fs.close(fd, function (err) {
                                if (err) self.server.emit("error", err);
                            });
                        }
                    });
                });
            }
        });
    }
};

FtpConnection.prototype._command_RMD = function (commandArg) {
    var self = this;

    var filename = withCwd(self.cwd, commandArg);
    self.fs.rmdir( PathModule.join(self.root, filename), function(err){
        if(err) {
            self._logIf(0, "Error removing directory " + filename);
            wwenc(self.socket, "550 Delete operation failed\r\n");
        } else
            wwenc(self.socket, "250 \"" + filename + "\" directory removed\r\n");
    });
};

FtpConnection.prototype._command_RNFR = function (commandArg) {
    var self = this;

    self.filefrom = withCwd(self.cwd, commandArg);
    self._logIf(3, "Rename from " + self.filefrom);
    self.fs.exists( PathModule.join(self.root, self.filefrom), function(exists) {
        if (exists) wwenc(self.socket, "350 File exists, ready for destination name\r\n");
        else wwenc(self.socket, "350 Command failed, file does not exist\r\n");
    });
};

FtpConnection.prototype._command_RNTO = function (commandArg) {
    var self = this;

    var fileto = withCwd(self.cwd, commandArg);
    self.fs.rename( PathModule.join(self.root, self.filefrom), PathModule.join(self.root, fileto), function(err){
        if(err) {
            self._logIf(3, "Error renaming file from " + self.filefrom + " to " + fileto);
            wwenc(self.socket, "550 Rename failed\r\n");
        } else {
            wwenc(self.socket, "250 File renamed successfully\r\n");
        }
    });
};

FtpConnection.prototype._command_SIZE = function (commandArg) {
    var self = this;

    var filename = withCwd(self.cwd, commandArg);
    self.fs.stat( PathModule.join(self.root, filename), function (err, s) {
        if(err) { 
            self._traceIf(0, "Error getting size of file '" + filename + "' ", self.socket);
            wwenc(self.socket, "450 Failed to get size of file\r\n");
            return;
        }
        wwenc(self.socket, "213 " + s.size + "\r\n");
    });
};

FtpConnection.prototype._command_TYPE = function (commandArg) {
    if (commandArg == "I" || commandArg == "A")
        wwenc(this.socket, "200 OK\r\n");
    else
        wwenc(this.socket, "202 Not supported\r\n");
};

FtpConnection.prototype._command_STOR = function (commandArg) {
    var self = this;
    var filename = withCwd(self.cwd, commandArg);
    var wStreamFlags = {flags:"w",mode:0644};
    var storeStream = self.fs.createWriteStream(PathModule.join(self.root, filename),wStreamFlags);
    var notErr = true;
    
    storeStream.on("open", function(fd){        
        self._logIf(3, "File opened/created: " + filename);
        self._logIf(3, "Told client ok to send file data");
        wwenc(self.socket, "150 Ok to send data\r\n", function () {
            self._whenDataReady(handleUpload);
        });
    });
    
    storeStream.on("error", function(err){
        if (err) {
            if (self.dataSocket) // dataSocket will have been set to null if 'end' event was raised.
                self.dataSocket.removeListener('data', storeStream.write);
            storeStream.destroy();
            notErr = false;
            wwenc(self.socket, "426 Connection closed; transfer aborted\r\n");
        }
    });
    
    storeStream.on("close", function() {
        notErr ? wwenc(self.socket, "226 Closing data connection\r\n") : true;
    });
    
    function handleUpload(dataSocket){
        self.dataSocket.on('data', function(buff){
            storeStream.write(buff);
        })
        self.dataSocket.once('error', function(buf){
            notErr = false;
            storeStream.destroy();            
        });
        self.dataSocket.once('close', function () {
            storeStream.end(); // send EOF/FIN
            storeStream.destroySoon(); // close once writestream is drained
        });
        
    };
};

var TLS_ONLY_AUTH_ERROR = "530 This server does not permit login over a non-secure connection; " +
                          "connect using FTP-SSL with explicit AUTH TLS\r\n";

FtpConnection.prototype._command_USER = function (commandArg) {
    var self = this;

    if (self.server.options.tlsOnly && !self.secure) {
        return wwenc(self.socket, TLS_ONLY_AUTH_ERROR);
    }

    // Authentication username.
    self.emit(
        "command:user",
        commandArg,
        function() { // implementor should call this on successful username check
            wwenc(self.socket, "331 Password required for " + commandArg + "\r\n");
        },
        function() { // call second callback if username unknown
            wwenc(self.socket, "530 Invalid username: " + commandArg + "\r\n");
        }
    );
};

FtpConnection.prototype._command_PASS = function () {
    var self = this;

    if (self.server.options.tlsOnly && !self.secure) {
        return wwenc(self.socket, TLS_ONLY_AUTH_ERROR);
    }

    // Authentication password.
    self.emit(
        "command:pass",
        commandArg,
        function(username, userFsModule) { // implementor should call this on successful password check
            wwenc(self.socket, "230 Logged on\r\n");
            self.username = username;
            if (userFsModule)
                self.fs = userFsModule;
            else
                self.fs = FsModule;
            self.cwd = self.server.getInitialCwd(username);
            self.root = self.server.getRoot(username);
        },
        function() { // call second callback if password incorrect
            wwenc(self.socket, "530 Invalid password\r\n");
            self.authFailures++;
            self.username = null;
        }
    );
};


exports.FtpServer = FtpServer;
