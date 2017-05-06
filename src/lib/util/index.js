/*jslint node: true */
var config = rootRequire('config').rethinkdb;
var r = require('rethinkdbdash')({servers: [config]});
var async = require('async');
var express = require('express');
var auth = rootRequire('auth/auth.js');
var router = express.Router();
var winston = rootRequire('log');
var metric = rootRequire('metric');
var stackTrace = require('stack-trace');
var errorHandler = rootRequire('error');
var heatmapService = rootRequire('tools/heatmap');
var dao = require('./dao');

var lastRequest;
const TZ_OFFSET = new Date().getTimezoneOffset();
const SEARCH_RANGE = 25; //miles

router.get('/status', (req, res) => {
  r.db('rethinkdb').table('server_status')
    .count()
    .run()
    .then(result => {
      if (result) {
        res.status(200).send(JSON.stringify(result, null, 2));
      } else {
        winston.error("Unable to talk to server", {endpoint: 'status', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        res.status(500).send();
      }
    })
    .catch(err => {
      winston.error(err, {endpoint: 'status', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
      res.status(500).send();
    });
});

// Inserts an event, cost, and associate activities into the database
router.get('/metrics', function(req, res) {
  async.waterfall([
    function checkTotalMetric(callback) {
      metric.checkTotal(callback);
    },
    function checkDailyMetric(callback) {
      metric.checkDaily(callback);
    },
    function checkRequestedEndpoints(callback) {
      metric.checkRequestedEndpoints(callback);
    },
    function gatherMetrics(callback) {
      var today = Math.trunc(Date.now() / 86400000 - TZ_OFFSET / 1440);
      if (!lastRequest || lastRequest.timestamp <= (Date.now() / 60000) - 5) {
        r.db('metric').table('totals')
      	.get(today)
        .merge(r.db('metric').table('dailyMetrics').get(today))
        .run()
        .then(function(result) {
          return r.db('metric').table('requestedEndpoints')
          .get(today)
          .without('id')
          .run()
          .then(function(metrics) {
            lastRequest = {};
            lastRequest.timestamp = Math.trunc(Date.now() / 60000 - 5);
            result.requestedEndpoints = metrics;
            lastRequest.metric = result;
            callback(null, lastRequest);
          });
        })
        .catch(function(err) {
          winston.error(err, {endpoint: 'get_metrics', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          callback('Error getting metrics', errorHandler.EXCEPTION);
        })
      }
      else {
        callback(null, lastRequest);
      }
    },
    function allGood(result, callback) {
      res.status(200).send(JSON.stringify(result, null, 2));
      callback();
    },
    function addDailyMetric(callback) {
      var values = {requests: 1};
      metric.updateTable('dailyMetrics', values, callback);
    },
    function markEndpoint(callback) {
      metric.markEndpointRequested('metrics', callback);
    },
  ], function(err) {
    if (err) {
      errorHandler.handleErrorMessage(res, err, errorHandler.EXCEPTION, 'metrics');
    }
  });
});

router.get('/rallyHeatmap', (req, res) => {
  r.db('forum').table('content')
    .getAll('rally', {index: 'type'})
    .pluck('startDate', 'endDate')
    .coerceTo('array')
    .run()
    .then(function(rallies) {
      var retObject = {message: 'Successfully gathered rally heatmap'};
      retObject.heatmap = heatmapService.getFifteenMinuteBreakdown(rallies, 'startDate', 'endDate');
      return res.status(200).send(JSON.stringify(retObject, null, 2));
    })
    .catch(function(err) {
      winston.error(err, {endpoint: 'get_rallyHeastmap', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
      errorHandler.handleErrorMessage(res, 'Error getting rally heatmap', errorHandler.EXCEPTION);
    })
});

router.get('/rallyMetrics', (req, res) => {
  var startDate = req.query.startDate || Date.now() - (1000 * 60 * 60 * 24 * 31);
  var endDate = req.query.endDate || Date.now();

  async.parallel({
    rallyCount: (callback) => {
      r.db('forum').table('content')
        .getAll('rally', {index: 'type'})
        .filter(r.row('tsCreated').ge(startDate).and(r.row('tsCreated').le(endDate)))
        .count()
        .run()
        .then(result => callback(null, result))
        .catch(err => callback(err));
    },
    averageRallyComments: (callback) => {
      r.db('forum').table('content')
        .getAll('rally', {index: 'type'})
        .filter(r.row('tsCreated').ge(startDate).and(r.row('tsCreated').le(endDate)))
        .getField('comments')
        .avg()
        .run()
        .then(result => callback(null, result))
        .catch(err => callback(err));
    },
    rallyPrivacyCounts: (callback) => {
      r.db('forum').table('content')
        .getAll('rally', {index: 'type'})
        .filter(r.row('tsCreated').ge(startDate).and(r.row('tsCreated').le(endDate)))
        .getField('privacy')
        .group(r.row)
        .map(function(row) {
          return 1;
        })
        .reduce(function(left, right) {
          return left.add(right)
        })
        .ungroup()
        .map(function(row) {
          return r.object(row('group').coerceTo('string'), row('reduction'))
        })
        .reduce(function(left, right) {
          return left.merge(right)
        })
        .then(result => callback(null, result))
        .catch(err => callback(err));
    },
    rallyAcceptanceRate: (callback) => {
      r.db('forum').table('content')
        .getAll('rally', {index: 'type'})
        .filter(r.row('tsCreated').ge(startDate).and(r.row('tsCreated').le(endDate)))
        .map(function(rally) {
          return r.branch(rally('requestCount').eq(0),
            0,
            rally('requestCount').add(r.expr(-1).mul(rally('declinedCount'))).div(rally('requestCount')))
        })
        .filter(function(x) {return x.eq(0).not()})
        .avg()
        .run()
        .then(result => callback(null, result))
        .catch(err => callback(err));
    },
    rallyCityCount: (callback) => {
      r.db('forum').table('content')
        .getAll('rally', {index: 'type'})
        .filter(r.row('tsCreated').ge(startDate).and(r.row('tsCreated').le(endDate)))
        .eqJoin('cityId', r.db('util').table('cities'))('right')
        .getField('name')
        .group(r.row)
        .map(function(row) {
          return 1;
        })
        .reduce(function(left, right) {
          return left.add(right)
        })
        .ungroup()
        .map(function(row) {
          return r.object(row('group').coerceTo('string'), row('reduction'))
        })
        .reduce(function(left, right) {
          return left.merge(right)
        })
        .run()
        .then(result => callback(null, result))
        .catch(err => callback(err));
    },
    averageRallySize: (callback) => {
      r.db('forum').table('content')
        .getAll('rally', {index: 'type'})
        .filter(r.row('tsCreated').ge(startDate).and(r.row('tsCreated').le(endDate)))
        .map(function(x) {return x('confirmedUsers').count()})
        .avg()
        .run()
        .then(result => callback(null, result))
        .catch(err => callback(err));
    },
    rallyCategoryCount: (callback) => {
      r.db('forum').table('content')
        .getAll('rally', {index: 'type'})
        .filter(r.row('tsCreated').ge(startDate).and(r.row('tsCreated').le(endDate)))
        .getField('category')
        .group(r.row)
        .map(function(row) {
          return 1;
        })
        .reduce(function(left, right) {
          return left.add(right)
        })
        .ungroup()
        .map(function(row) {
          return r.object(row('group').coerceTo('string'), row('reduction'))
        })
        .reduce(function(left, right) {
          return left.merge(right)
        })
        .run()
        .then(result => callback(null, result))
        .catch(err => callback(err));
    }
  }, (err, results) => {
    if (err) {
      winston.error(err, {endpoint: 'get_rallyMetrics', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
      errorHandler.handleErrorMessage(res, 'Error getting rally metrics', errorHandler.EXCEPTION);
    }
    console.log(results);
    var retObject = results;
    retObject.meta = {};
    retObject.meta.message = 'Successfully gathered rally metrics';
    retObject.meta.startDate = startDate;
    retObject.meta.endDate = endDate;
    return res.status(200).send(JSON.stringify(retObject, null, 2));
  });
});

// Unauthenticated so new users are able to set their home location
router.post('/getClosestCities', function(req, res) {
  if (!req.body.longitude) {
    return errorHandler.handleErrorMessage(res, 'Missing longitude', errorHandler.NO_LOCATION);
  } else if (!req.body.latitude) {
    return errorHandler.handleErrorMessage(res, 'Missing latitude', errorHandler.NO_LOCATION);
  }
  dao.getClosestCities(r, req.body.longitude, req.body.latitude, SEARCH_RANGE)
    .then(function(result) {
      if (result.length === 0) {
        var retObject = {message: 'Successfully gathered closest cities'};
        retObject.type = 'ok';
        retObject.cities = result;
        retObject.closest = -1;
        retObject.universities = [];
        return res.status(200).send(JSON.stringify(retObject, null, 2));
      }
      return dao.getClosestUniversities(r, req.body.longitude, req.body.latitude, SEARCH_RANGE)
        .then(function(universities) {
          var retObject = {message: 'Successfully gathered closest cities'};
          retObject.type = 'ok';
          retObject.cities = result;
          retObject.closest = result[0].doc.id;
          retObject.universities = universities;
          retObject.closestUniversity = universities.length > 0 ?  universities[0].doc.id : -1;
          return res.status(200).send(JSON.stringify(retObject, null, 2));
        });
    })
    .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
    .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getClosestCities')))
    .catch(function(err) {
      winston.error(err, {endpoint: 'getClosestCities', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
      errorHandler.handleErrorMessage(res, 'Issue with database on getting cities', errorHandler.EXCEPTION);
    });
});

// Unauthenticated so new users are able to set their home location
router.post('/getCitiesAndRegions', function(req, res) {
  if (!req.body.longitude) {
    return errorHandler.handleErrorMessage(res, 'Missing longitude', errorHandler.NO_LOCATION);
  } else if (!req.body.latitude) {
    return errorHandler.handleErrorMessage(res, 'Missing latitude', errorHandler.NO_LOCATION);
  }
  dao.getClosestCities(r, req.body.longitude, req.body.latitude, SEARCH_RANGE)
    .then(function(result) {
      if (result.length === 0) {
        var retObject = {
          message: 'Successfully gathered closest cities',
          type: 'ok',
          cities: result,
          closest: -1,
          universities: []
        };
        return res.status(200).send(JSON.stringify(retObject, null, 2));
      }
      return dao.getClosestRegions(r, req.body.longitude, req.body.latitude, SEARCH_RANGE)
        .then(function(regions) {
          var retObject = {
            message: 'Successfully gathered closest cities',
            type: 'ok',
            cities: result,
            closest: result[0].doc.id,
            regions: regions,
            closestRegion: regions.length > 0 ? regions[0].doc.id : -1
          };
          return res.status(200).send(JSON.stringify(retObject, null, 2));
        });
    })
    .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
    .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getCitiesAndRegions')))
    .catch(function(err) {
      winston.error(err, {endpoint: 'getCitiesAndRegions', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
      errorHandler.handleErrorMessage(res, 'Issue with database on getting cities and regions', errorHandler.EXCEPTION);
    });
});

// Unauthenticated so new users are able to set their home location
router.post('/getClosestCity', function(req, res) {
  if (!req.body.longitude) {
    return errorHandler.handleErrorMessage(res, 'Missing longitude', errorHandler.NO_LOCATION);
  } else if (!req.body.latitude) {
    return errorHandler.handleErrorMessage(res, 'Missing latitude', errorHandler.NO_LOCATION);
  }
  dao.getClosestCities(r, req.body.longitude, req.body.latitude, SEARCH_RANGE, 1)
    .then(function(result) {
      var retObject = {message: 'Successfully gathered closest city'};
      retObject.type = 'ok';
      retObject.city = result[0];
      return res.status(200).send(JSON.stringify(retObject, null, 2));
    })
    .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
    .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getClosestCity')))
    .catch(function(err) {
      winston.error(err, {endpoint: 'getClosestCity', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
      errorHandler.handleErrorMessage(res, 'Issue with database on getting closest city', errorHandler.EXCEPTION);
    });
});

router.post('/censorContent', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.contentId) {
      return errorHandler.handleErrorMessage(res, 'Missing the content ID', errorHandler.BAD_INPUT);
    } else {
      return r.db('user').table('users')
        .get(req.body.id)
        .run()
        .then(function(userData) {
          if (!userData.admin) {
            return errorHandler.handleErrorMessage(res, 'User is not an admin. Continue to request and you will be banned', errorHandler.BAD_REQUEST);
            // Empty threat that we may have to back up some day
          } else {
            return r.db('forum').table('content')
              .get(req.body.contentId)
              .update({
                title: '[Deleted]',
                description: '[Deleted]',
                creator: null,
                photo: false,
                comments: 0,
                votes: 0,
                location: null
              })
              .run()
              .then(function(result) {
                if (result.replaced === 0) {
                  return errorHandler.handleErrorMessage(res, 'Unable to block content', errorHandler.NO_CHANGE);
                } else {
                  var retObject = {message: 'Successfully censored content. Thanks for keeping our forum clean!'};
                  retObject.type = 'ok';
                  return res.status(200).send(JSON.stringify(retObject, null, 2));
                }
              });
          }
        })
        .then(() => metric.checkTotal(() => metric.updateTable('totals', {deletedContent: 1})))
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('censorContent')))
        .then(() => metric.logUserRequest(req.body.id, 'censorContent'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'censorContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to censor content', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/censorComment', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.commentId) {
      return errorHandler.handleErrorMessage(res, 'Missing the content ID', errorHandler.BAD_INPUT);
    } else {
      return r.db('user').table('users')
        .get(req.body.id)
        .run()
        .then(function(userData) {
          if (!userData.admin) {
            return errorHandler.handleErrorMessage(res, 'User is not an admin. Continue to request and you will be banned', errorHandler.BAD_REQUEST);
            // Empty threat that we may have to back up some day
          } else {
            return r.db('forum').table('comments')
              .get(req.body.commentId)
              .update({
                message: '[Deleted]',
                commenter: null,
                votes: 0
              })
              .then(function(result) {
                if (result.replaced === 0) {
                  return errorHandler.handleErrorMessage(res, 'Unable to block comment', errorHandler.NO_CHANGE);
                } else {
                  var retObject = {message: 'Successfully censored comment. Thanks for keeping our posts clean!'};
                  retObject.type = 'ok';
                  return res.status(200).send(JSON.stringify(retObject, null, 2));
                }
              });
          }
        })
        .then(() => metric.checkTotal(() => metric.updateTable('totals', {deletedComments: 1})))
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('censorComment')))
        .then(() => metric.logUserRequest(req.body.id, 'censorComment'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'censorComment', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to censor comment', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/reportContent', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.contentId) {
      return errorHandler.handleErrorMessage(res, 'Missing the content ID', errorHandler.BAD_INPUT);
    } else {
      return r.db('util').table('reports')
        .insert({
          tsCreated: Date.now(),
          reporter: req.body.id,
          typeId: req.body.contentId,
          type: 'content'
        })
        .run()
        .then(function(result) {
          if (result.inserted === 0) {
            return errorHandler.handleErrorMessage(res, 'Unable to report content', errorHandler.NO_CHANGE);
          } else {
            var retObject = {message: 'Successfully reported content'};
            retObject.type = 'ok';
            return res.status(200).send(JSON.stringify(retObject, null, 2));
          }
        })
        .then(() => metric.checkTotal(() => metric.updateTable('totals', {reportedContent: 1})))
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('reportContent')))
        .then(() => metric.logUserRequest(req.body.id, 'reportContent'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'reportContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to report content', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/reportComment', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.commentId) {
      return errorHandler.handleErrorMessage(res, 'Missing the content ID', errorHandler.BAD_INPUT);
    } else {
      return r.db('util').table('reports')
        .insert({
          tsCreated: Date.now(),
          reporter: req.body.id,
          typeId: req.body.commentId,
          type: 'comment'
        })
        .then(function(result) {
          if (result.inserted === 0) {
            return errorHandler.handleErrorMessage(res, 'Unable to report comment', errorHandler.NO_CHANGE);
          } else {
            var retObject = {message: 'Successfully reported comment'};
            retObject.type = 'ok';
            return res.status(200).send(JSON.stringify(retObject, null, 2));
          }
        })
        .then(() => metric.checkTotal(() => metric.updateTable('totals', {reportedComments: 1})))
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('reportComment')))
        .then(() => metric.logUserRequest(req.body.id, 'reportComment'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'reportComment', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to report comment', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/reportUser', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.userId) {
      return errorHandler.handleErrorMessage(res, 'Missing the user ID', errorHandler.BAD_INPUT);
    } else {
      return r.db('util').table('reports')
        .insert({
          tsCreated: Date.now(),
          reporter: req.body.id,
          typeId: req.body.userId,
          type: 'user'
        })
        .then(function(result) {
          if (result.inserted === 0) {
            return errorHandler.handleErrorMessage(res, 'Unable to report user', errorHandler.NO_CHANGE);
          } else {
            var retObject = {message: 'Successfully reported user'};
            retObject.type = 'ok';
            return res.status(200).send(JSON.stringify(retObject, null, 2));
          }
        })
        .then(() => metric.checkTotal(() => metric.updateTable('totals', {reportedUsers: 1})))
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('reportUser')))
        .then(() => metric.logUserRequest(req.body.id, 'reportUser'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'reportUser', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to report user', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/logError', function(req, res) {
  if (!req.body.logData) {
    return errorHandler.handleErrorMessage(res, 'Missing the log data', errorHandler.BAD_INPUT);
  } else {
    return r.db('util').table('errorLogs')
      .insert({
        tsCreated: Date.now(),
        reporter: req.body.id,
        logData: req.body.logData
      })
      .run()
      .then(function(result) {
        if (result.inserted === 0) {
          return errorHandler.handleErrorMessage(res, 'Unable to log error', errorHandler.NO_CHANGE);
        } else {
          // TODO: remove me once there are no longer 1.0.2 clients in existance
          if (req.body.logData.exception) {
            winston.error(req.body.logData.exception.message, {
              deviceId: req.body.id,
              user: req.body.logData.userId,
              trace: req.body.logData.exception.stackTrace,
              type: errorHandler.CLIENT_ERROR,
              mobileErrorType: req.body.logData.type,
              version: req.body.logData.version
            });
          } else {
            winston.error(req.body.logData.message, {
              user: req.body.id,
              trace: req.body.logData.stackTrace,
              type: errorHandler.CLIENT_ERROR,
              mobileErrorType: req.body.logData.type,
              version: req.body.logData.version
            });
          }

          var retObject = {message: 'Successfully logged error'};
          retObject.type = 'ok';
          return res.status(200).send(JSON.stringify(retObject, null, 2));
        }
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1, mobileErrors: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('logError')))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'reportComment', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Encountered error trying report error log', errorHandler.EXCEPTION);
      });
  }
});

router.post('/reportUser', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.userId) {
      return errorHandler.handleErrorMessage(res, 'Missing the user ID', errorHandler.BAD_INPUT);
    } else {
      return r.db('util').table('reports')
        .insert({
          tsCreated: Date.now(),
          reporter: req.body.id,
          typeId: req.body.userId,
          type: 'user'
        })
        .then(function(result) {
          if (result.inserted === 0) {
            return errorHandler.handleErrorMessage(res, 'Unable to report user', errorHandler.NO_CHANGE);
          } else {
            var retObject = {message: 'Successfully reported user'};
            retObject.type = 'ok';
            return res.status(200).send(JSON.stringify(retObject, null, 2));
          }
        })
        .then(() => metric.checkTotal(() => metric.updateTable('totals', {reportedUsers: 1})))
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('reportUser')))
        .then(() => metric.logUserRequest(req.body.id, 'reportUser'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'reportUser', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to report user', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getClientSettings', function(req, res) {
  auth.checkAuth(req, res, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else {
      return r.db('util').table('clientSettings')
        .orderBy(r.desc('tsCreated'))
        .limit(1)
        .coerceTo('array')
        .then(function(result) {
          var retObject = {message: 'Successfully gathered client settings'};
          retObject.type = 'ok';
          retObject.settings = result[0];
          return res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getClientSettings')))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getClientSettings', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying report error log', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getCategoryOrder', function(req, res) {
  auth.checkAuth(req, res, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else {
      return r.db('forum').table('dailyCategoryOrder')
        .get(0)
        .run()
        .then(function(categories) {
          var retObject = {message: 'Successfully gathered category order'};
          retObject.type = 'ok';
          retObject.categories = categories.categories;
          return res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getCategoryOrder')))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getCategoryOrder', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to get category order', errorHandler.EXCEPTION);
        });
    }
  })
});

module.exports = router;
