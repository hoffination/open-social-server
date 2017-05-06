/*jslint node: true */
var config = rootRequire('config').rethinkdb;
var r = require('rethinkdbdash')({servers: [config], buffer: 20});
var express = require('express');
var auth = rootRequire('auth/auth.js');
var router = express.Router();
var winston = rootRequire('log');
var metric = rootRequire('metric');
var errorHandler = rootRequire('error');
var stackTrace = require('stack-trace');
var R = require('ramda');
var mapper = rootRequire('tools/mappers');

router.post('/search', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(error) {
    if (error) {
      return errorHandler.handleErrorMessage(res, error, errorHandler.AUTH);
    } else if (!req.body.query) {
      return errorHandler.handleErrorMessage(res, 'No query given', errorHandler.BAD_INPUT);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No user id given', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'No city id given', errorHandler.BAD_INPUT);
    } else {
      var limit = 20;
      r.db('user').table('users')
        .get(req.body.id)('contacts')
        .run()
        .then(function(contacts) {
          if (!req.body.searchType) {
            return searchAll(req, res, contacts, limit);
          } else if (req.body.searchType === 'post') {
            return searchPosts(req, res, contacts, limit);
          } else if (req.body.searchType === 'event') {
            return searchEvents(req, res, contacts, limit);
          } else if (req.body.searchType === 'rally') {
            return searchRallies(req, res, contacts, limit);
          } else if (req.body.searchType === 'user') {
            return searchUsers(req, res, contacts, limit);
          }
        })
        .then(function(result) {
          var retObject = {message: 'Successfully executed ' + (req.body.searchType ? req.body.searchType + ' ' : ' ') + 'search'};
          retObject.type = 'ok';
          retObject.result = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('search')))
        .then(() => metric.logUserRequest(req.body.id, 'search'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'search', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying search', errorHandler.EXCEPTION);
        });
    }
  });
});

function searchAll(req, res, contacts, limit) {
  var subLimits = Math.round(limit / 4);
  return searchUsers(req, res, contacts, subLimits)
    .then(users => {
      return searchPosts(req, res, contacts, subLimits)
        .then(posts => {
          posts = posts.map(postData => {
            postData.voted = (postData.voteList.indexOf(req.body.id) !== -1);
            return postData;
          });
          return searchEvents(req, res, contacts, subLimits)
            .then(events => {
              events = events.map(eventData => {
                eventData.voted = (eventData.voteList.indexOf(req.body.id) !== -1);
                return eventData;
              });
              return searchRallies(req, res, contacts, subLimits)
                .then(rallies => {
                  return R.concat(users, R.concat(rallies, R.concat(events, posts)));
                });
            })
        });
    });
}

function getUserContacts(id) {
  return r.db('user').table('users')
    .get(id)
    .getField('contacts')
    .run()
}

function searchUsers(req, res, contacts, limit) {
  return r.db('user').table('users')
    .filter(function(doc) {
      return r.expr(contacts).contains(doc('id'))
        .and(doc.hasFields('isFeed').not())
        .and(doc('name').match('(?i)' + req.body.query).default(false));
    })
    .coerceTo('array')
    .setUnion(r.db('user').table('users')
      .filter(function(doc) {
        return doc('name').match('(?i)' + req.body.query).default(false)
          .and(doc.hasFields('isFeed').not());
      })
      .coerceTo('array'))
    .pluck('homeCityId', 'id', 'imageUrl', 'location', 'name')
    .limit(limit)
    .run()
}

function searchPosts(req, res, contacts, limit) {
  return r.db('forum').table('content')
    .getAll('post', {index: 'type'})
    .filter(function(doc) {
      return doc('title').match('(?i)' + req.body.query);
    })
    .orderBy(r.desc('votes'))
    .limit(limit)
    .run()
}

function searchEvents(req, res, contacts, limit) {
  var now = Date.now();
  return r.db('forum').table('content')
    .getAll('event', {index: 'type'})
    .filter(function(doc) {
      return doc('type').eq('event')
        .and(doc('title').match('(?i)' + req.body.query))
        .and(doc('cityId').eq(req.body.cityId))
        .and(doc('startDate').gt(now))
    })
    .orderBy(r.asc('startDate'))
    .coerceTo('array')
    .setUnion(r.db('forum').table('content')
      .getAll('event', {index: 'type'})
      .filter(function(doc) {
        return doc('title').match('(?i)' + req.body.query)
          .and(doc('endDate').gt(now))
      })
      .orderBy(r.asc('startDate'))
      .coerceTo('array'))
    .limit(limit)
    .run()
}

function searchRallies(req, res, contacts, limit) {
  var now = Date.now();
  return r.db('forum').table('rallyInvites')
    .getAll(req.body.id, {index: 'to'})
    .filter({isPending: true})
    .getField('rallyId')
    .coerceTo('array')
    .run()
    .then(rallyIds => {
      return r.db('forum').table('content')
        .getAll('rally', {index: 'type'})
        .filter(function(doc) {
          return doc('title').match('(?i)' + req.body.query)
            .and(doc('confirmedUsers').setIntersection(contacts).isEmpty().not())
            .and(doc('privacy').eq('public')
              .or(r.expr(contacts).contains(doc('creator'))
                .and(doc('privacy').eq('protected'))))
            .and(doc('startDate').gt(now))
        })
        .orderBy(r.asc('startDate'))
        .coerceTo('array')
        .setUnion(r.db('forum').table('content')
          .getAll('rally', {index: 'type'})
          .filter(function(doc) {
            return doc('title').match('(?i)' + req.body.query)
              .and(doc('cityId').eq(req.body.cityId))
              .and(doc('privacy').eq('public'))
              .and(doc('startDate').gt(now))
          })
          .orderBy(r.asc('startDate'))
          .coerceTo('array'))
        .setUnion(r.db('forum').table('content')
          .getAll('rally', {index: 'type'})
          .filter(function(doc) {
            return doc('title').match('(?i)' + req.body.query)
              .and(doc('privacy').eq('public')
                .or(doc('creator').eq(req.body.id))
                .or(doc('confirmedUsers').setUnion(doc('members')).setIntersection(r.expr([req.body.id])).isEmpty().not())
                .or(r.expr(rallyIds).contains(doc('id'))))
              .and(doc('endDate').gt(now))
          })
          .orderBy(r.asc('startDate'))
          .coerceTo('array'))
        .without('address', 'declined', 'lastHeuristicUpdate', 'lastModified', 'requestCount')
        .limit(limit)
        .run()
        .then(rallies => {
          return getUserContacts(req.body.id)
            .then(contacts => {
              return rallies.map(rallyData => {
                rallyData.isPending = rallyIds.indexOf(rallyData.id) !== -1;
                return mapper.mapRallyData(rallyData, req.body.id, contacts)
              });
            })
        })
    });
}

module.exports = router;
