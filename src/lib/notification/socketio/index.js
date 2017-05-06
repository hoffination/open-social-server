var express = require('express');
var server = require('http').Server(express());
var config = rootRequire('config').rethinkdb;
var r = require('rethinkdbdash')({servers: [config]});
var winston = rootRequire('log');
var metric = rootRequire('metric');
var stackTrace = require('stack-trace');

module.exports = function(io) {
  io.on('connection', function(socket) {
    var now = Date.now();
    socket.on('initNotification', function(identifier) {
      winston.info('a user connected', {user: identifier, endpoint: 'socketio'});
        return r.db('notification').table('events')
          .filter(function(item) {
            return item('time').gt(now).and(
              item('user2').eq(identifier))
          })
          .changes()
          .run()
          .then(function(cursor) {
            cursor.each(function(err, item) {
              if (item && item.new_val && !item.old_val) {
                socket.emit('notification', item.new_val);
              }
            })
            socket.on('disconnect', function() {
              winston.info('a user disconnected correctly', {endpoint: 'socketio'});
              cursor.close();
            })
          })
          .then(function() {
            metric.checkDaily(function() {
              var values = {users: identifier};
              metric.updateTable('dailyMetrics', values);
            });
          })
          .catch(function(err) {
            winston.error(JSON.stringify(err),
              {user: identifier, endpoint: 'socketio', trace: stackTrace.parse(err)});
          });
    });
  });
}
