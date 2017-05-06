var config = rootRequire('config').rethinkdb;
var r = require('rethinkdbdash')({servers: [config], buffer: 40});
var async = require('async');
var express = require('express');
var auth = rootRequire('auth/auth.js');
var router = express.Router();
var winston = rootRequire('log');
// var socket = require('./socketio');
var metric = rootRequire('metric');
var stackTrace = require('stack-trace');
var R = require('ramda');
var errorHandler = rootRequire('error');
var notify = rootRequire('tools/notify');

// router.post('/sendNotification', function(req, res) {
//   if (!req.body.id) {
//     return errorHandler.handleErrorMessage(res, 'No id source given', errorHandler.BAD_INPUT);
//   } else if (!req.body.user) {
//     return errorHandler.handleErrorMessage(res, 'No user given', errorHandler.BAD_INPUT);
//   } else if (!req.body.type) {
//     return errorHandler.handleErrorMessage(res, 'No notification type given', errorHandler.BAD_INPUT);
//   } else {
//     if (!req.body.item) {
//       req.body.item = '';
//     }
//     auth.checkAuthAndId(req, res, req.body.id, function(err) {
//       if (err) {
//         return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
//       }
//       r.db('notification').table('events')
//         .insert({
//           user2: req.body.id,
//           user1: req.body.user,
//           type: req.body.type,
//           time: Date.now(),
//           item: req.body.item,
//           viewed: false
//         })
//         .run()
//         .then(function(result) {
//           var retObject = {message: 'Notification successfully sent'};
//           retObject.type = 'ok';
//           retObject.resultId = result.generated_keys[0];
//           res.status(200).send(JSON.stringify(retObject, null, 2));
//         })
//         .then(function() {
//           return metric.checkDaily(function() {
//             metric.updateTable('dailyMetrics', {requests: 1});
//           });
//         })
//         .then(function() {
//           return metric.checkRequestedEndpoints(function() {
//             metric.markEndpointRequested('sendNotification');
//           });
//         })
//         .then(function logUserRequestEndpoint() {
//           metric.logUserRequest(req.body.id, 'sendNotification');
//         })
//         .catch(function(err) {
//           winston.warn(JSON.stringify(err),
//             {user: req.body.id, endpoint: 'sendNotification', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
//           errorHandler.handleErrorMessage(res, 'Issue with database on sending notification', errorHandler.EXCEPTION);
//         });
//     });
//   }
// });

// Deprecated
// router.post('/getNotifications', function(req, res) {
//   if (!req.body.id) {
//     return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
//   } else {
//     if (!req.body.datetime) {
//       req.body.datetime = 0;
//     }
//     auth.checkAuthAndId(req, res, req.body.id, function(err) {
//       if (err) {
//         return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
//       }
//       r.db('notification').table('events')
//         .filter(function(item) {
//           return item('time').gt(parseInt(req.body.datetime)).and(
//             item('user2').eq(req.body.id))
//         })
//         .pluck('id', 'user1', 'type', 'time', 'item', 'viewed')
//         .coerceTo('array')
//         .run()
//         .then(function(result) {
//           var retObject = {message: 'Successfully got notifications. CAUTION: Deprecated!'};
//           retObject.type = 'ok';
//           retObject.notifications = result;
//           res.status(200).send(JSON.stringify(retObject, null, 2));
//         })
//         .then(function() {
//           return metric.checkDaily(function() {
//             metric.updateTable('dailyMetrics', {requests: 1});
//           });
//         })
//         .then(function() {
//           return metric.checkRequestedEndpoints(function() {
//             metric.markEndpointRequested('getNotification');
//           });
//         })
//         .then(function logUserRequestEndpoint() {
//           metric.logUserRequest(req.body.id, 'getNotification');
//         })
//         .catch(function(err) {
//           winston.warn(err, {user: req.body.id, endpoint: 'getNotifications', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
//           errorHandler.handleErrorMessage(res, 'Issue with database getting notifications', errorHandler.EXCEPTION);
//         });
//     });
//   }
// });

router.post('/getNewNotifications', function(req, res) {
  if (!req.body.id) {
    return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
  } else {
    auth.checkAuthAndId(req, res, req.body.id, function(err) {
      if (err) {
        return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
      }
      r.db('notification').table('events')
        .filter(function(item) {
          return item('viewed').eq(false).and(item('user2').eq(req.body.id));
        })
        .pluck('id', 'user1', 'type', 'time', 'item', 'viewed')
        .coerceTo('array')
        .run()
        .then(function(result) {
          var retObject = {message: 'Successfully got new notifications'};
          retObject.type = 'ok';
          retObject.notifications = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(function() {
          return metric.checkDaily(function() {
            metric.updateTable('dailyMetrics', {requests: 1});
          });
        })
        .then(function() {
          return metric.checkRequestedEndpoints(function() {
            metric.markEndpointRequested('getNewNotifications');
          });
        })
        .then(function logUserRequestEndpoint() {
          metric.logUserRequest(req.body.id, 'getNewNotifications');
        })
        .catch(function(err) {
          winston.warn(err, {user: req.body.id, endpoint: 'getNewNotifications', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Issue with database getting notifications', errorHandler.EXCEPTION);
        });
    });
  }
});

router.post('/markNotificationViewed', function(req, res) {
  if (!req.body.id)
    return errorHandler.handleErrorMessage(res, 'No user ID given', errorHandler.BAD_INPUT);
  if (!req.body.notifications) {
    return errorHandler.handleErrorMessage(res, 'No notifications given', errorHandler.BAD_INPUT);
  } else if (Object.prototype.toString.call(req.body.notifications) !== '[object Array]' && typeof req.body.notifications !== 'string') {
    return errorHandler.handleErrorMessage(res, 'No notification array or single string given', errorHandler.BAD_INPUT);
  } else if (req.body.notifications.length === 0) {
    return errorHandler.handleErrorMessage(res, 'Notifications array was found empty', errorHandler.BAD_INPUT);
  } else {
    if (typeof req.body.notifications === 'string') {
      req.body.notifications = R.of(req.body.notifications);
    }
    auth.checkAuthAndId(req, res, req.body.id, function(err) {
      if (err) {
        return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
      } else {
        r.db('notification').table('events')
          .getAll(req.body.id, {index: 'user2'})
          .filter(function(note) {
            return r.expr(req.body.notifications).contains(note('id'));
          })
          .update({viewed: true})
          .run()
          .then(function(result) {
            if (result.replaced !== 0) {
              var retObject = {
                message: 'Successuflly marked ' + result.replaced.toString() + ' notifications viewed',
                type: 'ok'
              };
              res.status(200).send(JSON.stringify(retObject, null, 2));
            } else {
              return errorHandler.handleErrorMessage(res, 'No notifications changed viewed status', errorHandler.NO_CHANGE);
            }
          })
          .then(function updateMetrics() {
            metric.checkDaily(function() {
              metric.updateTable('dailyMetrics', {requests: 1}, function() {
                metric.checkRequestedEndpoints(function() {
                  metric.markEndpointRequested('markNotificationViewed');
                  metric.logUserRequest(req.body.id, 'markNotificationViewed');
                })
              })
            })
          })
          .catch(function(err) {
            winston.warn(err, {user: req.body.id, endpoint: 'markNotificationViewed', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
            errorHandler.handleErrorMessage(res, 'No notifications changed viewed status', errorHandler.EXCEPTION);
          });
      }
    });
  }
});

router.post('/confirmNotificationService', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else {
      notify.createNotification(r, null, req.body.id, 'confirmNotification', null, true);
      var retObject = {
        message: 'Successuflly sent confirmation notification',
        type: 'ok'
      };
      res.status(200).send(JSON.stringify(retObject, null, 2));
    }
  });
});

module.exports = router;
