/*jslint node: true */
// Allows us to use the lib directory for most local calls
global.rootRequire = function(name) {
  return require(__dirname + '/lib/' + name);
};

// Use the config and app resource to open the main server port
var cfg = rootRequire('config');
var app = rootRequire('app');
var winston = rootRequire('log');

var server = app.listen(process.env.PORT || cfg.port);
winston.info('Starting ' + cfg.env + ' server on port ' + cfg.port);

process.on('uncaughtException', function(err) {
  winston.error(err.message, {trace: err.stack});
  process.exit(1);
})

process.on('unhandledRejection', (reason, p) => {
  winston.error(reason, {trace: p})
});

// var io = require('socket.io').listen(server);
// rootRequire('notification/socketio')(io);
