#!/usr/bin/env node

var dgram = require('dgram')
  , util = require('util')
  , http = require('http')
  , https = require('https')
  , querystring = require('querystring')
  , emitter = require('events').EventEmitter
  , config = require(userConfig())
  , fs = require('fs')
  , net = require('net')

if (config.syslog) {
    try {
        var syslog = require('node-syslog');
        syslog.init('node2dm', syslog.LOG_PID | syslog.LOG_ODELAY, syslog.LOG_DAEMON);
    } catch (e) {
        config.syslog = false;
        log('node-syslog is required for syslog support.');
    }
}

function userConfig() {
  return process.argv[2] ?
           process.argv[2].replace(/.js$/, '') :
           './config'
}

function log(msg) {
    if (config.syslog) {
        syslog.log(syslog.LOG_INFO, msg);
    } else {
        util.log(msg);
    }
}

function C2DMMessage(deviceToken, collapseKey, notification) {
    this.deviceToken = deviceToken;
    this.collapseKey = collapseKey;
    this.notification = notification;
}

function C2DMReceiver(config, connection) {

    this.server = dgram.createSocket('udp4', function (msg, rinfo) {

        var msgParts = msg.toString().match(/^([^:]+):([^:]+):(.*)$/);
        if (!msgParts) {
            log("Invalid message");
            return;
        };
        var token = msgParts[1];
        var collapseKey = msgParts[2];
        var notification = JSON.parse(msgParts[3]);

        var c2dmMessage = new C2DMMessage(token, collapseKey, notification);
        connection.notifyDevice(c2dmMessage);
    });
    this.server.bind(config.port || 8120);
    log("server is up");
}


function C2DMConnection(config) {

    var self = this;

    this.c2dmServerOptions = {
        "host": "android.apis.google.com",
        "path": "/c2dm/send",
        "method": "POST"
    }

    this.gcmServerOptions = {
        "host": "android.googleapis.com", //https
        "path": "/gcm/send",
        "method": "POST"
    }
	

    this.loginOptions = {
        "host": "www.google.com",
        "path": "/accounts/ClientLogin",
        "method": "POST",
        "headers": {'Content-Type': 'application/x-www-form-urlencoded'}

    }

    this.currentAuthorizationToken = null;
    this.authFails = 0;

    var blockedFromSending = false;
    var retryAfter = 0;
    var authInProgress = false;

    // if we exceed device quota for an ID,
    // place token in this group; it will
    // get cleared every 60 minutes
    this.rateLimitedTokens = {};

    // on fail, queue up here
    var pendingMessages = [];
    var totalMessages = 0;
    var totalErrors = 0;
    var authTokenTime = null;
    var startupTime = Math.round(new Date().getTime() / 1000);

    this.requeueMessage = function(message) {
        pendingMessages.push(message);
    }

    this.retryPendingMessages = function() {
        var numMessages = pendingMessages.length;
        for (var i = 0; i < numMessages; i++) {
            var message = pendingMessages.shift();
            self.submitMessage(message);
        }
    }

    // clear rate limited every hour
    setInterval(function() {
        self.rateLimitedTokens = {};
    }, 60 * 60 * 1000);

    // ensure log-in every 10 seconds
//    function loginIfNotAuthenticated() {
//        if (!self.currentAuthorizationToken) {
//            //self.authenticate();
//        }
//    }

//    setInterval(function() {
//        loginIfNotAuthenticated();
//    }, 5 * 1000);

    this.on('loginComplete', function() {
        self.retryPendingMessages();
    });

    this.on('retryAfterExpired', function() {
        self.retryPendingMessages();
    });

    if (config.serverCallbackHost && config.serverCallbackPath) {
        this.on('badregistration', function(message) {
            // default to https
            var baseClass = (config.serverCallbackProtocol == 'http' ? http : https);
            var port = (config.serverCallbackPort || (config.serverCallbackProtocol == 'http' ? 80 : 443));
            var postBody = {
                device_token: message.deviceToken,
                message_body: message.notification,
                shared_secret: config.serverCallbackSharedSecret
            }
            var postBodyString = querystring.stringify(postBody);
            var webhookOptions = {
                host: config.serverCallbackHost,
                port: port,
                path: config.serverCallbackPath,
                method: "POST",
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': postBodyString.length
                }
            }
            var webhookReq = baseClass.request(webhookOptions, function(res) {});
            webhookReq.write(postBodyString);
            webhookReq.end();
        });
    }

    this.onError = function(message, err) {

        totalErrors++;
        var errMessage = err.match(/Error=(.+)$/);
        if (!errMessage) {
            log("Unknown error: " + err);
            return;
        }
        
        var googleError = errMessage[1];
        switch (googleError) {
            case "QuotaExceeded":
                log("WARNING: Google Quota Exceeded");
                // write a lock file; will require manual intervention
                fs.open('./quota.lock', 'w', '0666', function(e, id) {
                    fs.write(id, 'locked at ' + new Date().toString(), null, 'utf8', function() {
                        fs.close(id, function() {
                            process.exit(1);
                        });
                    });
                });
                break;

            case "DeviceQuotaExceeded":
                self.rateLimitedTokens[message.deviceToken] = true;
                break;

            case "InvalidRegistration":
                self.emit("badregistration", message);
                break;

            case "NotRegistered":
                self.emit("badregistration", message);
                break;

            case "MessageTooBig":
                log("ERROR: message too big");
                break;

        }

    }

    this.sendRequest = function(message) {
        log('sending msg to google!');
        if (blockedFromSending) {
            self.requeueMessage(message);
            return;
        }
        if (self.rateLimitedTokens[message.deviceToken]) {
            log("not sending; this token has been rate limited");
            return;
        }

        var c2dmPostBody = {
            registration_ids: [message.deviceToken],
            collapse_key: message.collapseKey,
            data: message.notification
        }

        var stringBody = JSON.stringify(c2dmPostBody);
        log(stringBody);
        var requestOptions =  {
            'host': self.gcmServerOptions.host,
            'path': self.gcmServerOptions.path,
            'method': 'POST',
            'headers': {
                'Content-Length': stringBody.length,
                'Content-Type': 'application/json',
                'Authorization': 'key='+config.apiKey
            }
        };

        var postRequest = https.request(requestOptions, function(response) {  
            log('response: ' + querystring.stringify(response));
            if (response.statusCode == 401) {
                // we need to reauthenticate
                self.currentAuthorizationToken = null;
                // requeue message
                self.requeueMessage(message);
            } else if (response.statusCode == 503) {
                retryAfter = parseInt(response.headers['Retry-After'], 10) || 10;
                blockedFromSending = true;
                self.requeueMessage(message);
                setTimeout(function() {
                    blockedFromSending = false;
                    self.emit('retryAfterExpired');
                }, retryAfter * 1000);
            } else if (response.statusCode == 200) { 
                response.setEncoding('utf-8');
                var buffer = '';
                response.on('data', function(chunk) {
                    buffer += chunk;
                    log(buffer);
                });
                response.on('end', function(end) {
                    var returnedID = buffer.match(/\"success\":1/);                    
                    if (!returnedID) {
                        self.onError(message, buffer);
                    }
                });
            }
        });

        postRequest.on('error', function(error) {
            totalErrors++;
            log(error);
        });

        postRequest.write(stringBody);
        postRequest.end();
    }

    this.submitMessage = function(message) {
        self.sendRequest(message);
    }

    this.notifyDevice = function(message) {
        totalMessages++;
        self.submitMessage(message);
    };

    this.debugServer = net.createServer(function(stream) {
        stream.setEncoding('ascii');

        stream.on('data', function(data) {
            var commandLine = data.trim().split(" ");
            var command = commandLine.shift();
            switch (command) {
                case "help":
                    stream.write("Commands: stats authtoken\n");
                    break;

                case "authtoken":
                    if (self.currentAuthorizationToken) {
                        stream.write("token: " + self.currentAuthorizationToken + "\n");
                    }
                    stream.write("END\n\n");
                    break;

                case "stats":
                    var now = Math.round(new Date().getTime() / 1000);
                    var elapsed = now - startupTime;

                    var tokenAge = now - authTokenTime;

                    stream.write("uptime: " + elapsed + " seconds\n");
                    stream.write("messages_sent: " + totalMessages + "\n");
                    stream.write("messages_in_queue: " + pendingMessages.length + "\n");
                    stream.write("backing_off: " + (blockedFromSending ? "true" : "false") + "\n");
                    stream.write("total_errors: " + totalErrors + "\n");
                    stream.write("rate_limited_tokens: " + Object.keys(self.rateLimitedTokens).length + "\n");
                    var loggedInStatus = (self.currentAuthorizationToken ? "true" :  "false");
                    stream.write("logged_in_to_c2dm: " + loggedInStatus + "\n");
                    if (self.currentAuthorizationToken) {
                        stream.write("token_age: " + tokenAge + " seconds\n");
                    }

                    var memoryUsage = process.memoryUsage();
                    for (var property in memoryUsage) {
                        stream.write("memory_" + property + ": " + memoryUsage[property] + "\n");
                    }
                    stream.write("END\n\n");
                    break;

                case "quit":
                    stream.end();
                    break;

                default:
                    stream.write("Invalid command\n");
                    break;
            };
        });

    });
    this.debugServer.listen(config.debugServerPort || config.port + 100);
}

util.inherits(C2DMConnection, emitter);


// check for a lock file; if it's there,
// don't start until removed
fs.stat('quota.lock', function(err, stats) {
    if (!err) {
        log("Can't start; quota.lock present");
        process.exit(1);
    }

    var connection = new C2DMConnection(config);
    var receiver = new C2DMReceiver(config, connection);
});

