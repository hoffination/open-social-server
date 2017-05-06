var config = rootRequire('config').rethinkdb;
var r = require('rethinkdbdash')({servers: [config]});
var express = require('express');
var auth = rootRequire('auth/auth.js');
var R = require('ramda');
var router = express.Router();
var winston = rootRequire('log');
var metric = rootRequire('metric');
var stackTrace = require('stack-trace');
var notify = rootRequire('tools/notify');
var errorHandler = rootRequire('error');

router.post('/upsertStatus', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.message) {
      return errorHandler.handleErrorMessage(res, 'Missing status message', errorHandler.BAD_INPUT);
    }
    r.db('user').table('status')
      .insert({
        tsCreated: Date.now(),
        id: req.body.id,
        message: req.body.message,
        startDate: req.body.startDate,
        endDate: req.body.endDate,
        interestedUsers: req.body.interestedUsers || []
      }, {conflict: 'replace'})
      .run()
      .then(function(result) {
        if (result.inserted === 0 && result.replaced === 0) {
          return errorHandler.handleErrorMessage(res, 'Unable to upsert status', errorHandler.NO_CHANGE);
        }
        var retObject = {message: 'Status upserted successfully'};
        retObject.type = 'ok';
        res.status(200).send(retObject);
      })
      .then(() => metric.checkTotal(() => metric.updateTable('totals', {totalStatuses: 1})))
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('upsertStatus')))
      .then(() => metric.logUserRequest(req.body.id, 'upsertStatus'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'upsertStatus', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Issue with database upserting status', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getStatus', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.userId) {
      return errorHandler.handleErrorMessage(res, 'Missing status user id', errorHandler.BAD_INPUT);
    }
    r.db('user').table('users')
      .get(req.body.id)
      .run()
      .then(function(userData) {
        if (req.body.id !== req.body.userId && (!userData || userData.contacts.indexOf(req.body.userId) === -1)) {
          return errorHandler.handleErrorMessage(res, 'Unable to find contact in user friend list', errorHandler.BAD_REQUEST);
        }
        r.db('user').table('status')
          .get(req.body.userId)
          .run()
          .then(function(status) {
            var retObject = {message: 'Successfully gathered status'};
            retObject.type = 'ok';
            retObject.status = status;
            res.status(200).send(retObject);
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getStatus')))
      .then(() => metric.logUserRequest(req.body.id, 'getStatus'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getStatus', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Issue with database getting status', errorHandler.EXCEPTION);
      });
  });
});

router.post('/deleteStatus', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    }
    r.db('user').table('status')
      .get(req.body.id)
      .delete()
      .run()
      .then(function(resolution) {
        if (resolution.deleted === 0) {
          return errorHandler.handleErrorMessage(res, 'Unable to Successfully delete status', errorHandler.NO_CHANGE);
        }
        var retObject = {message: 'Successfully deleted Status status'};
        retObject.type = 'ok';
        res.status(200).send(retObject);
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deleteStatus')))
      .then(() => metric.logUserRequest(req.body.id, 'deleteStatus'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'deleteStatus', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Issue with database deleting status', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getContactStatuses', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    }
    r.expr(r.db('user').table('users').get(req.body.id)('contacts'))
      .eqJoin(function(doc) { return doc; }, r.db('user').table("status"))
      .zip()
      .coerceTo('array')
      .run()
      .then(function(statuses) {
        var retObject = {message: 'Successfully gathered contact statuses'};
        retObject.type = 'ok';
        retObject.statuses = statuses;
        res.status(200).send(retObject);
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getContactStatuses')))
      .then(() => metric.logUserRequest(req.body.id, 'getContactStatuses'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getContactStatuses', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Issue with database on gathering contact statuses', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getLastActiveContacts', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    }
    r.db('user').table('users')
      .get(req.body.id)
      .getField('contacts')
      .run()
      .then(function(contacts) {
        if (!contacts || contacts.length === 0) {
          return [];
        }
        return r.db('metric').table('userLastActive')
          .getAll(r.args(contacts))
          .coerceTo('array')
          .run()
      })
      .then(function(lastActive) {
        lastActive = lastActive.map(x => {
          x.userId = x.id;
          delete x.id;
          return x;
        });
        var retObject = {message: 'Successfully gathered contacts last active'};
        retObject.type = 'ok';
        retObject.statuses = lastActive;
        res.status(200).send(retObject);
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getLastActiveContacts')))
      .then(() => metric.logUserRequest(req.body.id, 'getLastActiveContacts'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getLastActiveContacts', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Issue with database on gathering contact last active dates', errorHandler.EXCEPTION);
      });
  });
});

router.post('/userAddInterest', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.userId) {
      return errorHandler.handleErrorMessage(res, 'Missing status owner id', errorHandler.BAD_INPUT);
    }
    r.db('user').table('status')
      .get(req.body.userId)
      .run()
      .then(function(status) {
        if (!status) {
          return errorHandler.handleErrorMessage(res, 'Unable to find status', errorHandler.BAD_REQUEST);
        }
        r.db('user').table('status')
          .get(req.body.userId)
          .update({interestedUsers: r.row('interestedUsers').setUnion(r.expr([req.body.id]))})
          .run()
          .then(function(resolution) {
            if (resolution.replaced === 0) {
              return errorHandler.handleErrorMessage(res, 'Unable to add user to interested users list', errorHandler.NO_CHANGE);
            }
            var retObject = {message: 'Status added user to interested users list'};
            retObject.type = 'ok';
            res.status(200).send(retObject);
            notify.createNotification(r, req.body.id, req.body.userId, 'userAddInterest', null);
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('userAddInterest')))
      .then(() => metric.logUserRequest(req.body.id, 'userAddInterest'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'userAddInterest', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Issue with database on user add interest', errorHandler.EXCEPTION);
      });
  });
});

router.post('/userRemoveInterest', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.userId) {
      return errorHandler.handleErrorMessage(res, 'Missing status owner id', errorHandler.BAD_INPUT);
    }
    r.db('user').table('status')
      .get(req.body.userId)
      .run()
      .then(function(status) {
        if (!status) {
          return errorHandler.handleErrorMessage(res, 'Unable to find status', errorHandler.BAD_REQUEST);
        } else if (status.interestedUsers.indexOf(req.body.id) === -1) {
          return errorHandler.handleErrorMessage(res, 'Unable to find user in list of interested users', errorHandler.BAD_REQUEST)
        }
        return r.db('user').table('status')
          .get(req.body.userId)
          .update({interestedUsers: r.row('interestedUsers').filter(function(r) {
              return r.eq(req.body.id).not();
            })
          })
          .run()
          .then(function(resolution) {
            if (resolution.replaced === 0) {
              return errorHandler.handleErrorMessage(res, 'Unable to remove user from interested users list', errorHandler.NO_CHANGE);
            }
            var retObject = {message: 'Status removed user from interested users list'};
            retObject.type = 'ok';
            res.status(200).send(retObject);
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('userRemoveInterest')))
      .then(() => metric.logUserRequest(req.body.id, 'userRemoveInterest'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'userRemoveInterest', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Issue with database on user remove interest', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getFeaturedStatuses', function(req, res) {
  auth.checkAuth(req, res, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    r.db('user').table('featuredStatus')
      .filter(r.row.hasFields('tsCreated').not().and(r.row.hasFields('startDate').not()))
      .getField('status')
      .coerceTo('array')
      .run()
      .then(function(defaultStatuses) {
        r.db('user').table('featuredStatus')
          .filter(r.row('startDate').lt(Date.now()))
          .orderBy(r.desc(r.row('startDate')))
          .limit(3)
          .getField('status')
          .coerceTo('array')
          .run()
          .then(function(featuredStatuses) {
            r.db('user').table('featuredStatus')
              .filter(r.row.hasFields('startDate').not().and(r.row.hasFields('tsCreated')))
              .orderBy(r.desc(r.row('count')))
              .limit(3)
              .getField('status')
              .coerceTo('array')
              .run()
              .then(function(popularStatuses) {
                var retObject = {message: 'Successfully gathered featured statuses'};
                retObject.type = 'ok';
                retObject.statuses = R.concat(defaultStatuses, R.concat(featuredStatuses, popularStatuses));
                res.status(200).send(retObject);
              })
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getFeaturedStatuses')))
      .then(() => metric.logUserRequest(req.body.id, 'getFeaturedStatuses'))
      .catch(function(err) {
        winston.error(err, {endpoint: 'getFeaturedStatuses', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Issue with database on user remove interest', errorHandler.EXCEPTION);
      });
  });
});

// Creating more statuses
//////////////////////////////////////////////////////
// // Create status populus option
// r.db('user').table('featuredStatus')
//   .insert({
//     count: 0,
//     tsCreated: Date.now(),
//     status: ''
//   })
//
// // Create status seasonalOption (featured)
// r.db('user').table('featuredStatus')
//   .insert({
//     startDate: Date.now(),
//     status: ''
//   })
//
// // Create generic status
// r.db('user').table('featuredStatus')
//   .insert({
//     status: ''
//   })
/////////////////////////////////////////////////////

module.exports = router;
