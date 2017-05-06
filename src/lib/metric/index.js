var config = rootRequire('config').rethinkdb;
var r = require('rethinkdbdash')({servers: [config]});
var async = require('async');
var R = require('ramda');
var winston = rootRequire('log');
var errorHandler = rootRequire('error');
var stackTrace = require('stack-trace');

metrics = {};
metrics.checkTotal = function(callback) {
  var day = Math.trunc(new Date().getTime()/86400000 - new Date().getTimezoneOffset() / 1440);
  r
  .db('metric').table('totals')
  .orderBy({index: r.desc('id')})
  .limit(1)
  .coerceTo('array')
  .run()
  .then(function(result) {
    if (result[0].id !== day) {
      var newTotals = R.merge(result[0], {id: day});
      r
      .db('metric')
      .table('totals')
      .insert(newTotals)
      .run()
      .then(function() {
        winston.info('Created totals for today');
        if (callback) callback();
      })
    } else {
      if (callback) callback();
    }
  })
  .catch(function(err) {
    winston.error(err, {endpoint: 'func_checkTotal', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
    if (callback) callback();
  });
};

metrics.checkDaily = function(callback) {
  var day = Math.trunc(new Date().getTime()/86400000 - new Date().getTimezoneOffset() / 1440);
  r
  .db('metric').table('dailyMetrics')
  .orderBy({index: r.desc('id')})
  .limit(1)
  .coerceTo('array')
  .run()
  .then(function(result) {
    if (result.length === 0 || result[0].id !== day) {
      r
      .db('metric').table('dailyMetrics')
      .insert({
        id: day,
        users: [],
        newUsers: 0,
        requests: 0,
        mobileErrors: 0,
        errors: 0
      })
      .run()
      .then(function() {
        winston.info('Created daily metrics for today');
        if (callback) callback();
      })
    } else {
      if (callback) callback();
    }
  })
  .catch(function(err) {
    winston.error(err, {endpoint: 'func_checkDaily', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
    if (callback) callback();
  });
};

metrics.checkRequestedEndpoints = function(callback) {
  var day = Math.trunc(new Date().getTime()/86400000 - new Date().getTimezoneOffset() / 1440);
  r
  .db('metric').table('requestedEndpoints')
  .get(day)
  .replace(function(row) {
    return r.branch(
      row.eq(null),
      { id: day },
      row
    )
  })
  .run()
  .then(function() {
    if (callback) callback();
  })
  .catch(function(err) {
    winston.error(err, {endpoint: 'func_checkRequestedEndpoints', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
    if (callback) callback();
  });
};

metrics.checkInterests = function(callback) {
  var day = Math.trunc(Date.now()/86400000 - new Date().getTimezoneOffset() / 1440);
  r
  .db('metric').table('interests')
  .get(day)
  .replace(function(row) {
    return r.branch(
      row.eq(null),
      { id: day },
      row
    )
  })
  .run()
  .then(function(resolution) {
    if (callback) callback();
  })
  .catch(function(err) {
    winston.error(err, {endpoint: 'func_checkInterests', trace: stackTrace.parse(err)});
    if (callback) callback();
  });
};

metrics.updateTable = function(table, values, callback) {
  var day = Math.trunc(Date.now()/86400000 - new Date().getTimezoneOffset() / 1440);
  r
  .db('metric').table(table)
  .get(day)
  .replace(function(row) {
    return row.merge(function() {
      var metrics = {};
      for (var i in values) {
        if (i === 'users' && table === 'dailyMetrics') {
          metrics[i] = row(i).setInsert(values[i]);
        } else {
          metrics[i] = row(i) ? row(i).add(values[i]) : values[i];
        }
      }
      return metrics;
    })
  })
  .run()
  .then(function(resolution) {
    if (resolution.replaced === 0 && resolution.inserted === 0) {
      winston.error('Unable to updateTable', {endpoint: 'func_updateTable', type: errorHandler.NO_CHANGE, reqBody: {
        table: table, values: values
      }});
    }
    if (callback) callback();
  })
  .catch(function(err) {
    winston.error(err, {endpoint: 'func_updateTable', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
    if (callback) callback();
  });
};

metrics.markEndpointRequested = function(endpoint, callback) {
  var day = Math.trunc(Date.now()/86400000 - new Date().getTimezoneOffset() / 1440);
  var endpoints = {};
  r.db('metric').table('requestedEndpoints')
  .get(day)
  .replace(function(row) {
    endpoints[endpoint] = r.branch(
        row.hasFields(endpoint),
        row(endpoint).add(1),
        1
      );
    return row.merge(function() {
      return endpoints;
    });
  })
  .run()
  .then(function(resolution) {
    if (resolution.replaced === 0 && resolution.inserted === 0) {
      winston.error('Unable to mark endpoint requested', {endpoint: 'func_logUserRequest', type: errorHandler.NO_CHANGE, reqBody: {endpoint: endpoint}});
    }
    if (callback) callback();
  })
  .catch(function(err) {
    winston.error(err, {endpoint: 'func_markEndpointRequested', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
    if (callback) callback();
  });
};

metrics.logUserRequest = function(userId, endpoint, callback) {
  if (!userId) {
    if (callback)
      return callback();
    else
      return;
  }
  r.db('metric').table('userRequests')
    .insert({
      userId: userId,
      endpoint: endpoint,
      timestamp: Date.now()
    })
    .run()
    .then(function(resolution) {
      if (resolution.inserted === 0) {
        winston.error('Unable to insert user log of endpoint request', {endpoint: 'func_logUserRequest', type: errorHandler.NO_CHANGE});
      }
      r.db('metric').table('userLastActive')
        .insert({
          id: userId,
          timestamp: Date.now()
        }, {conflict: 'replace'})
        .run()
        .then(function(resolution) {
          if (callback) callback();
        })
    })
    .catch(function(err) {
      winston.error(err, {endpoint: 'func_logUserRequest', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
      if (callback) callback();
    });
}

module.exports = metrics;
