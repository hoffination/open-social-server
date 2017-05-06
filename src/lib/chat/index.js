var config = rootRequire('config').rethinkdb;
var r = require('rethinkdbdash')({servers: [config]});
var auth = rootRequire('auth/auth.js');
var express = require('express');
var router = express.Router();
var winston = rootRequire('log');
var metric = rootRequire('metric');
var stackTrace = require('stack-trace');
var notify = rootRequire('tools/notify');
var errorHandler = rootRequire('error');

// Send message from one user to another user in the database
router.post('/sendMessage', function(req, res) {
  var message = '';
  if (!req.body.toId) {
    return errorHandler.handleErrorMessage(res, 'no toId given to send message to', errorHandler.BAD_INPUT);
  }
  if (!req.body.id) {
    return errorHandler.handleErrorMessage(res, 'no id given to send message from', errorHandler.BAD_INPUT);
  }
  if (!req.body.message) {
    return errorHandler.handleErrorMessage(res, 'no specified message given to send message', errorHandler.BAD_INPUT);
  }
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    r.db('chat').table('chats').insert({
      toId: req.body.toId,
      fromId: req.body.id,
      timestamp: Date.now(),
      message: req.body.message,
    })
    .run()
    .then(function(result) {
      var retObject = {message: 'Message successfully sent'};
      retObject.type = 'ok';
      res.status(200).send(retObject);
      notify.createNotification(r, req.body.id, req.body.toId, 'message', null, false);
      return result;
    })
    .then(function() {
      metric.checkRequestedEndpoints(function() {
        metric.markEndpointRequested('sendMessage');
      });
      metric.checkDaily(function() {
        var values = {requests: 1};
        metric.updateTable('dailyMetrics', values);
      });
    })
    .then(function() {
      return metric.logUserRequest(req.body.id, 'sendMessage');
    })
    .catch(function(err) {
      winston.error(err, {user: req.body.id, type: errorHandler.EXCEPTION, endpoint: 'sendMessage', reqBody: req.body, trace: stackTrace.parse(err)});
      errorHandler.handleErrorMessage(res, 'Issue with database on sending message', errorHandler.EXCEPTION);
    });
  });
});

// Get the last messages for each contact in a conversation with the given user
router.post('/getLastMessages', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No user ID given', errorHandler.BAD_INPUT);
    }
    r.db('user').table('users')
      .get(req.body.id)
      .getField('blockedUsers')
      .run()
      .then(function(users) {
        return r.db('chat').table('chats')
          .getAll(req.body.id, {index: 'fromId'})
          .getField('toId')
          .union(r.db('chat').table('chats')
            .getAll(req.body.id, {index: 'toId'})
            .getField('fromId'))
          .distinct()
          .filter(function(userId) {
            return r.expr(users).contains(userId).not();
          })
          .map(function(val) {
            return r.db('chat').table('chats')
              .getAll([req.body.id, val], {index: 'to_from'})
              .union(
                r.db('chat').table('chats')
                  .getAll([val, req.body.id], {index: 'to_from'})
              )
              .max('timestamp')
              .default(0);
          })
          .filter(function(values) {
            return values.eq(0).not();
          })
          .coerceTo('Array')
          .run()
          .then(function(result) {
            var retObject = {message: 'Successfully found last message'};
            retObject.type = 'ok';
            retObject.lastMessages = result;
            res.status(200).send(JSON.stringify(retObject, null, 2));
          })
      })
      .then(function() {
        metric.checkRequestedEndpoints(function() {
          metric.markEndpointRequested('getLastMessages');
        });
        metric.checkDaily(function() {
          var values = {requests: 1};
          metric.updateTable('dailyMetrics', values);
        });
      })
      .then(function() {
        return metric.logUserRequest(req.body.id, 'getLastMessages');
      })
      .catch(function(err) {
        winston.error(err, {user: req.body.id, type: errorHandler.EXCEPTION, endpoint: 'getLastMessages', reqBody: req.body, trace: stackTrace.parse(err)});
        return errorHandler.handleErrorMessage(res, 'Unable to get last messages due to a server error', errorHandler.EXCEPTION);
      });
  });
});

// Get all of the messages for a user to or from a contact after a given date
// If no date is given, we should get all messages
router.post('/getNewMessages', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No user ID given', errorHandler.BAD_INPUT);
    }
    if (!req.body.contactId) {
      return errorHandler.handleErrorMessage(res, 'No contactId given', errorHandler.BAD_INPUT);
    }
    if (typeof req.body.datetime === 'string') {
      return errorHandler.handleErrorMessage(res, 'Datetime must be a UTC millisecond date', errorHandler.BAD_INPUT);
    }
    if (!req.body.datetime) {
      req.body.datetime = 0;
    }

    r.db('chat').table('chats')
      .getAll([req.body.id, req.body.contactId], {index:'to_from'})
      .union(
        r.db('chat').table('chats')
      		.getAll([req.body.contactId, req.body.id], {index:'to_from'})
      )
      .filter(function(value) {
        return value('timestamp').gt(req.body.datetime);
      })
      .coerceTo('Array')
      .run()
      .then(function(result) {
        var retObject = {message: 'Successfully gathered new messages'};
        retObject.type = 'ok';
        retObject.newMessages = result
        res.status(200).send(JSON.stringify(retObject, null, 2));

        // mark contact notifications viewed
        return r.db('notification').table('events')
          .getAll(req.body.id, {index: 'user2'})
          .filter({viewed: false, user1: req.body.contactId})
          .update({viewed: true})
          .run()
      })
      .then(function() {
        metric.checkRequestedEndpoints(function() {
          metric.markEndpointRequested('getNewMessages');
        });
        metric.checkDaily(function() {
          var values = {requests: 1};
          metric.updateTable('dailyMetrics', values);
        });
      })
      .then(function() {
        return metric.logUserRequest(req.body.id, 'getNewMessages');
      })
      .catch(function(err) {
        winston.error(err, {user: req.body.id, type: errorHandler.EXCEPTION, endpoint: 'getLastMessages', reqBody: req.body, trace: stackTrace.parse(err)});
        return errorHandler.handleErrorMessage(res, 'Unable to get new messages due to a server error', errorHandler.EXCEPTION);
      });
  });
});

module.exports = router;
