/*jslint node: true */
var config = rootRequire('config');
var r = require('rethinkdbdash')({servers: [config.rethinkdb]});
var async = require('async');
var auth = rootRequire('auth/auth.js');
var express = require('express');
var router = express.Router();
var winston = rootRequire('log');
var metric = rootRequire('metric');
var stackTrace = require('stack-trace');
var AWS = require('aws-sdk');
AWS.config.update(config.awsAccess);
var s3 = new AWS.S3();
var cloudfront = new AWS.CloudFront();
var notify = rootRequire('tools/notify');
var heuristicService = rootRequire('tools/heuristic');
var mapper = rootRequire('tools/mappers');
var errorHandler = rootRequire('error');
var R = require('ramda');

// GETTERS
// -------------------------------------------------------------------------------------

router.post('/getForum', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.forum) {
      return errorHandler.handleErrorMessage(res, 'No forum id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('forums')
      .get(req.body.forum)
      .run()
      .then(function(result) {
        var retObject = {message: 'Successfully gathered forum data'};
        retObject.type = 'ok';
        retObject.forum = result;
        res.status(200).send(JSON.stringify(retObject, null, 2));
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getForum')))
      .then(() => metric.logUserRequest(req.body.id, 'getForum'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getForum', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getContent', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.contentId) {
      return errorHandler.handleErrorMessage(res, 'No content id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('content')
      .get(req.body.contentId)
      .without('cityId', 'declinedCount', 'lastHeuristicUpdate', 'lastModified', 'requestCount')
      .run()
      .then(function(result) {
        if (result.type === 'rally') {
          return r.db('forum').table('rallyInvites')
            .getAll(req.body.id, {index:'to'})
            .filter({
              rallyId: req.body.contentId,
              isPending: true
            })
            .coerceTo('array')
            .run()
            .then(invites => {
              if (invites && invites.length) {
                result.isInvited = true;
              }
              return r.db('user').table('users')
                .get(req.body.id)
                .getField('contacts')
                .contains(result.creator)
                .run()
                .then(function(isContact) {
                  var retObject = {message: 'Successfully gathered content'};
                  retObject.type = 'ok';
                  retObject.forum =  mapper.mapRallyContentView(result, req.body.id, isContact);
                  res.status(200).send(JSON.stringify(retObject, null, 2));
                });
            });
        } else {
          result.voted = result.voteList.indexOf(req.body.id) !== -1;
          delete result.voteList;
          var retObject = {message: 'Successfully gathered content'};
          retObject.type = 'ok';
          retObject.forum = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        }
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getForumContent')))
      .then(() => metric.logUserRequest(req.body.id, 'getForumContent'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getForumContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getCategories', function(req, res) {
  auth.checkAuth(req, res, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    r.db('forum').table('forums')
      .pluck('category', 'icon')
      .distinct()
      .coerceTo('array')
      .run()
      .then(function(result) {
        var retObject = {message: 'Successfully gathered category list'};
        retObject.type = 'ok';
        retObject.result = result;
        res.status(200).send(JSON.stringify(retObject, null, 2));
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getCategories')))
      .then(() => metric.logUserRequest(req.body.id, 'getCategories'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getCategories', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Error getting categories', errorHandler.EXCEPTION);
      });
  });
});

// Returns a list of all comments for a particular post
router.post('/getGroupedComments', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.postId) {
      return errorHandler.handleErrorMessage(res, 'No postId given', errorHandler.BAD_INPUT);
    } else if (req.body.postId && !req.body.parentCommentId) {
      r.db('forum').table('comments')
        .getAll(req.body.postId, {index: 'postId'})
        .map(function(doc) {
          return doc.merge({'voted': doc('voteList').contains(req.body.id)})
        })
        .pluck('commenter', 'photoId', 'commenterName', 'comments', 'datetime', 'id', 'message', 'parentId', 'voted', 'votes', 'updateComment')
        .group('parentId')
        .run()
        .then(function(result) {
          return r.db('user').table('users')
            .get(req.body.id)
            .run()
            .then(function(userData) {
              var retObject = {message: 'Successfully gathered comments'};
              retObject.type = 'ok';
              retObject.comments = result.map(x => {
                x.reduction = x.reduction.map(comment => {
                  if (comment.postType !== 'rally' && (userData.blockedUsers.indexOf(comment.commenter) !== -1 || userData.blockedBy.indexOf(comment.commenter) !== -1)) {
                    comment.commenterName = '[Deleted]';
                    comment.message = '[Deleted]';
                    comment.photoId = '';
                    delete comment.commenter;
                    return comment;
                  } else {
                    return comment;
                  }
                })
                return x;
              });
              res.status(200).send(JSON.stringify(retObject, null, 2));
            });
        })
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getGroupedComments', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
        });
    } else {
      r.db('forum').table('comments')
        .getAll(req.body.parentCommentId, {index: 'parentId'})
        .map(function(doc) {
          return doc.merge({'voted': doc('voteList').contains(req.body.id)})
        })
        .pluck('commenter', 'photoId', 'commenterName', 'comments', 'datetime', 'id', 'message', 'parentId', 'voted', 'votes')
        .coerceTo('array')
        .run()
        .then(function(result) {
          var retObject = {message: 'Successfully gathered comments'};
          retObject.type = 'ok';
          // Organize data like other request
          retObject.comments = {group: req.body.parentCommentId, reduction: result};
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getGroupedComments', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
        });
    }
    metric.checkDaily(function() {
      metric.updateTable('dailyMetrics', {requests: 1});
    });
    metric.checkRequestedEndpoints(function() {
      metric.markEndpointRequested('getGroupedComments');
    });
    metric.logUserRequest(req.body.id, 'getGroupedComments');
  });
});

// Returns a list of all forums that are either top-level or are sub-comments
// Giving both postId and parentCommentId will not improve performance even if
// we can re-implement but both must be provided
router.post('/getSpecificComments', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    }
    if (!req.body.postId) {
      req.body.postId = null;
    }
    if (!req.body.parentCommentId) {
      if (!req.body.postId) {
        return errorHandler.handleErrorMessage(res, 'Need either a parentCommentId or a postId', errorHandler.BAD_INPUT)
      }
      req.body.parentCommentId = null;
    }
    if (req.body.postId && !req.body.parentCommentId) {
      r.db('forum').table('comments')
        .getAll(req.body.postId, {index: 'postId'})
        .filter(function(entry) {
          return entry.hasFields('parentId').not();
        })
        .coerceTo('array')
        .run().then(function(result) {
          var retObject = {message: 'Successfully gathered specific comments'};
          retObject.type = 'ok';
          retObject.comments = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getSpecificComments', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
        });
    } else {
      r.db('forum').table('comments')
        .getAll(req.body.parentCommentId, {index: 'parentId'})
        .coerceTo('array')
        .run().then(function(result) {
          var retObject = {message: 'Successfully gathered comments'};
          retObject.type = 'ok';
          retObject.comments = result;
          // TODO: change this to the object rather than just the result
          res.status(200).send(JSON.stringify(result, null, 2));
        })
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getSpecificComments', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
        });
    }
    metric.checkDaily(function() {
      metric.updateTable('dailyMetrics', {requests: 1});
    });
    metric.checkRequestedEndpoints(function() {
      metric.markEndpointRequested('getSpecificComments');
    });
    metric.logUserRequest(req.body.id, 'getSpecificComments');
  });
});

////////////////////////// DEPRECATED ////////////////////////
// This will need a complete refactor to respect heuristics //
//////////////////////////////////////////////////////////////
// Returns a list of all content with a given category
// router.post('/getCategoryContent', function(req, res) {
//   var dateToday = Date.now() / 86400000;
//   auth.checkAuthAndId(req, res, req.body.id, (err) => {
//     if (err) {
//       return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
//     } else if (!req.body.id) {
//       return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
//     } else if (!req.body.category) {
//       return errorHandler.handleErrorMessage(res, 'No category given', errorHandler.BAD_INPUT);
//     } else if (!req.body.cityId) {
//       return errorHandler.handleErrorMessage(res, 'No cityId given', errorHandler.NO_LOCATION);
//     } else {
//       r.db('util').table('regions')
//         .getAll(req.body.cityId, {index: 'cityId'})
//         .innerJoin(r.db('util').table('regions'), function(city, region) {
//           return city('regionName').eq(region('regionName'));
//         })('right')('cityId')
//         .coerceTo('array')
//         .run()
//         .then(function(regions) {
//           var todayDate = Date.now();
//           if (regions.length > 0) {
//             return r.db('forum').table('content')
//               .getAll(req.body.category, {index: 'category'})
//               .filter(function(doc) {
//                 if (doc('type') === 'event') {
//                   return r.expr(regions).contains(doc('cityId')).and(doc('endDate').gt(todayDate));
//                 } else {
//                   return r.expr(regions).contains(doc('cityId'));
//                 }
//               })
//               .map(function(doc) {
//                 return doc.merge({'voted': doc('voteList').contains(req.body.id)})
//               })
//               .pluck(r.args(FORUM_SELECT))
//               .coerceTo('array')
//               .run()
//               .then(function(result) {
//                 calculateAndAppendHeuristics(req, result, (err, result2) => {
//                   if (err) {
//                     winston.error(err, {user: req.body.id, endpoint: 'getCategoryContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
//                     return errorHandler.handleErrorMessage(res, 'Problem calculating heuristics on result set', errorHandler.EXCEPTION)
//                   }
//                   sortByHeuristic(result, (err, finalResult) => {
//                     if (err) {
//                       winston.error(err, {user: req.body.id, endpoint: 'getCategoryContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
//                       return errorHandler.handleErrorMessage(res, 'Problem calculating heuristics on result set', errorHandler.EXCEPTION)
//                     }
//                     var retObject = {message: 'Successfully gathered category content'};
//                     retObject.type = 'ok';
//                     retObject.forums = result;
//                     res.status(200).send(JSON.stringify(retObject, null, 2));
//                   })
//                 })
//               })
//           } else {
//             winston.info('No region for cityId ' + req.body.cityId, {user: req.body.id, endpoint: 'getCategoryContent'});
//             return r.db('forum').table('content')
//               .getAll(req.body.category, {index: 'category'})
//               .filter({cityId: req.body.cityId})
//               .filter(function(doc) {
//                 return r.branch(doc('type').eq('event'),
//                   doc('endDate').gt(todayDate),
//                   true);
//               })
//               .map(function(doc) {
//                 return doc.merge({'voted': doc('voteList').contains(req.body.id)})
//               })
//               .pluck(r.args(FORUM_SELECT))
//               .coerceTo('array')
//               .run()
//               .then(function(result) {
//                 calculateAndAppendHeuristics(req, result, (err, result2) => {
//                   if (err) {
//                     winston.error(err, {user: req.body.id, endpoint: 'getCategoryContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
//                     return errorHandler.handleErrorMessage(res, 'Problem calculating heuristics on result set', errorHandler.EXCEPTION)
//                   }
//                   sortByHeuristic(result, (err, finalResult) => {
//                     if (err) {
//                       winston.error(err, {user: req.body.id, endpoint: 'getCategoryContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
//                       return errorHandler.handleErrorMessage(res, 'Problem calculating heuristics on result set', errorHandler.EXCEPTION)
//                     }
//                     var retObject = {message: 'Successfully gathered category content'};
//                     retObject.type = 'ok';
//                     retObject.forums = result;
//                     res.status(200).send(JSON.stringify(retObject, null, 2));
//                   })
//                 })
//               })
//           }
//         })
//         .then(function() {
//           metric.checkDaily(function() {
//             metric.updateTable('dailyMetrics', {requests: 1});
//           });
//           metric.checkRequestedEndpoints(function() {
//             metric.markEndpointRequested('getCategoryContent');
//           });
//           metric.logUserRequest(req.body.id, 'getCategoryContent');
//         })
//         .catch(function(err) {
//           winston.error(err, {user: req.body.id, endpoint: 'getCategoryContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
//           errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
//         });
//     }
//   });
// });

router.post('/getMyContent', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .getAll(req.body.id, {index: 'creator'})
        .union(r.branch(
            r.db('forum').table('comments')
              .getAll(req.body.id, {index: 'commenter'})
              .isEmpty().not(),
            r.db('forum').table('content')
              .getAll(r.args(r.db('forum').table('comments')
                .getAll(req.body.id, {index: 'commenter'})
                .getField('postId')
                .distinct()))
              .filter(function(post) {
                return post('type').eq('rally').not()
              }),
            []))
        .union(r.db('forum').table('content')
          .getAll('rally', {index: 'type'})
          .filter(r.row('confirmedUsers').contains(req.body.id)))
        .union(r.db('forum').table('content')
          .getAll('rally', {index: 'type'})
          .filter(r.row('members').contains(req.body.id)))
        .distinct()
        .without('address', 'declined', 'lastHeuristicUpdate', 'lastModified', 'requestCount')
        .run()
        .then(function(result) {
          var retObject = {message: 'Successfully gathered my content'};
          retObject.type = 'ok';
          retObject.content = result.map(post => {
            if (post.type === 'rally') {
              return mapper.mapRallyData(post, req.body.id);
            } else {
              post.voted = (post.voteList.indexOf(req.body.id) !== -1);
              delete post.voteList;
              return post
            }
          });
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getMyContent')))
        .then(() => metric.logUserRequest(req.body.id, 'getMyContent'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getMyContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying get my content', errorHandler.EXCEPTION);
        });
    }
  });
});

// Returns a list of all content with a given category
router.post('/getPersonalizedContent', (req, res) => {
  var dateToday = Date.now() / 86400000;
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'No cityId given', errorHandler.NO_LOCATION);
    } else {
      const REQUEST_LIMIT = 40;
      if (!req.body.page) {
        req.body.page = 0;
      }
      var todayDate = Date.now();
      return r.db('user').table('users')
        .get(req.body.id)
        .run()
        .then(userData => {
          return r.db('forum').table('dailyContentPercentages')
            .orderBy(r.desc('id'))
            .limit(1)
            .run()
            .then(percentageList => {
              var percentages = percentageList[0];
              if (!percentages) {
                winston.error('No Percentages Found On Server', {user: req.body.id, endpoint: 'getPersonalizedContent', type: errorHandler.EXCEPTION});
                return errorHandler.handleErrorMessage(res, 'Unable to handle forum request', errorHandler.EXCEPTION);
              }
              console.time('forumGather');

              return r.db('user').table('users')
                .get(req.body.id)
                .getField('contacts')
                .run()
                .then(contacts => {
                  async.parallel({
                    posts: (callback) => {
                      r.db('forum').table('content')
                        .getAll('post', 'question', {index: 'type'})
                        .orderBy(r.desc('heuristic'))
                        .filter(function(doc) {
                          return doc('lastHeuristicUpdate').gt(dateToday - 604800000)
                            .and(r.expr(userData.blockedUsers).contains(doc('creator')).not())
                            .and(r.expr(userData.blockedBy).contains(doc('creator')).not());
                        })
                        .skip(req.body.page * Math.trunc(REQUEST_LIMIT * percentages.posts))
                        .limit(Math.trunc(REQUEST_LIMIT * percentages.posts))
                        .run()
                        .then(result => {
                          callback(null, result.map(postData => {
                            postData.voted = (postData.voteList.indexOf(req.body.id) !== -1);
                            return postData;
                          }))
                        })
                        .catch(err => callback(err));
                    },
                    events: (callback) => {
                      r.db('forum').table('content')
                        .getAll('event', {index: 'type'})
                        .orderBy(r.desc('heuristic'))
                        .filter(function(doc) {
                          return doc('lastHeuristicUpdate').gt(dateToday - 604800000)
                            .and(doc('endDate').gt(todayDate))
                            .and(r.expr(userData.blockedBy).contains(doc('creator')).not())
                            .and(r.expr(userData.blockedUsers).contains(doc('creator')).not())
                        })
                        .skip(req.body.page * Math.trunc(REQUEST_LIMIT * percentages.events))
                        .limit(Math.trunc(REQUEST_LIMIT * percentages.events))
                        .run()
                        .then(result => {
                          callback(null, result.map(eventData => {
                            eventData.voted = (eventData.voteList.indexOf(req.body.id) !== -1);
                            return eventData;
                          }))
                        })
                        .catch(err => callback(err));
                    },
                    rallies: (callback) => {
                      r.db('forum').table('content')
                        .getAll('rally', {index: 'type'})
                        .orderBy(r.desc('heuristic'))
                        .filter(function(doc) {
                          return doc('endDate').gt(todayDate).and(doc('privacy').eq('public'))
                            .and(r.expr(userData.blockedUsers).contains(doc('creator')).not())
                            .and(r.expr(userData.blockedBy).contains(doc('creator')).not());
                        })
                        .skip(req.body.page * Math.trunc(REQUEST_LIMIT * percentages.rallies))
                        .limit(Math.trunc(REQUEST_LIMIT * percentages.rallies))
                        .outerJoin(
                          r.db('forum').table('rallyInvites').getAll(req.body.id, {index: 'to'}),
                          function(rally, invite) {
                            return invite('isPending').eq(true).and(rally('id').eq(invite('rallyId')))
                          })
                        .without({
                          right: ['id', 'to', 'rallyId', 'from'],
                          left: ['address', 'creator', 'declined', 'lastHeuristicUpdate', 'lastModified', 'requestCount']
                        })
                        .zip()
                        .run()
                        .then(result => {
                          callback(null, result.map(rallyData => mapper.mapRallyData(rallyData, req.body.id, contacts)))
                        })
                        .catch(err => callback(err));
                    },
                    contactRallies: (callback) => {
                      // Only append contact related rallies on the first page request
                      if (req.body.page === 0) {
                        return r.db('forum').table('rallyInvites')
                          .getAll(req.body.id, {index: 'to'})
                          .filter({isPending: true})
                          .getField('rallyId')
                          .coerceTo('array')
                          .run()
                          .then(rallyIds => {
                            return r.db('forum').table('content')
                              .getAll('rally', {index: 'type'})
                              .filter(rally => {
                                return rally('endDate').gt(Date.now())
                                  .and(rally('confirmedUsers').setIntersection(contacts).isEmpty().not()
                                    .and(rally('privacy').eq('public').or(
                                      r.expr(contacts).contains(rally('creator'))
                                        .and(rally('privacy').eq('protected'))
                                    )))
                                  .or(r.expr(rallyIds).contains(rally('id')))
                              })
                              .distinct()
                              .coerceTo('array')
                              .run()
                              .then(activities => {
                                var result = activities.map(function(rally) {
                                  rally.type = 'contactRally';
                                  rally.isPending = rallyIds.indexOf(rally.id) !== -1;
                                  return mapper.mapRallyData(rally, req.body.id, contacts);
                                });
                                callback(null, result);
                              })
                          })
                          .catch(err => callback(err));
                      } else {
                        callback(null, []);
                      }
                    }
                  }, (err, results) => {
                    if (err) {
                      winston.error(err, {user: req.body.id, endpoint: 'getPersonalizedContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
                      return errorHandler.handleErrorMessage(res, 'Serious server issue getting personalized content', errorHandler.EXCEPTION);
                    }

                    let idList = [];
                    let result = R.concat(results.posts, R.concat(results.events, R.concat(results.contactRallies, results.rallies))).filter(x => {
                        if (idList.indexOf(x.id) === -1) {
                          idList.push(x.id);
                          return true;
                        } else {
                          return false;
                        }
                      });
                    heuristicService.applyLocation(result, req.body.cityId, weightedHeuristics => {
                      let retObject = {message: 'Successfully gathered personalized content'};
                      retObject.type = 'ok';
                      retObject.forums = heuristicService.interpolateValues(weightedHeuristics);
                      res.status(200).send(JSON.stringify(retObject, null, 2));
                      console.timeEnd('forumGather');
                    });
                  })
              })
            })
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getPersonalizedContent')))
        .then(() => metric.logUserRequest(req.body.id, 'getPersonalizedContent'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getPersonalizedContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
        });
    }
  });
});

// Should allow you to see public rallies your friends are going to and protected rallies your friends are hosting
router.post('/getContactFeed', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else {
      var now = Date.now();
      r.db('user').table('users')
        .get(req.body.id)
        .getField('contacts')
        .run()
        .then(contacts => {
          return r.db('forum').table('content')
            .getAll('rally', {index: 'type'})
            .filter(rally => {
              return rally('confirmedUsers').setIntersection(contacts).isEmpty().not()
                .and(rally('privacy').eq('public').or(
                  r.expr(contacts).contains(rally('creator'))
                    .and(rally('privacy').eq('protected'))
                ))
                .and(rally('endDate').gt(now))
            })
            .distinct()
            .coerceTo('array')
            .run()
            .then(activities => {
              var retObject = {message: 'Successfully gathered my contact feed'};
              retObject.type = 'ok';
              retObject.activities = activities.map(activity => mapper.mapRallyData(activity, req.body.id));
              res.status(200).send(JSON.stringify(retObject, null, 2));
            })
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getContactFeed')))
        .then(() => metric.logUserRequest(req.body.id, 'getContactFeed'))
        .catch(err => {
          winston.error(err, {user: req.body.id, endpoint: 'getContactFeed', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying get contact feed', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getFollowedForums', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('membership')
      .getAll(req.body.id, {index: 'userId'})
      .getField('forumId')
      .coerceTo('array')
      .run()
      .then(function(result) {
        var retObject = {message: 'Successfully gathered followed forum list'};
        retObject.type = 'ok';
        retObject.result = result;
        res.status(200).send(JSON.stringify(retObject, null, 2));
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getFollowedForums')))
      .then(() => metric.logUserRequest(req.body.id, 'getFollowedForums'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getFollowedForums', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Server error getting followed forums', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getForumMembers', function(req, res) {
  auth.checkAuth(req, res, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.forumId) {
      return errorHandler.handleErrorMessage(res, 'No forum id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('membership')
      .getAll(req.body.forumId, {index: 'forumId'})
      .pluck('forumId', 'userId', 'isMod')
      .coerceTo('array')
      .run()
      .then(function(result) {
        var retObject = {message: 'Successfully gathered forum member list'};
        retObject.type = 'ok';
        retObject.result = result;
        res.status(200).send(JSON.stringify(retObject, null, 2));
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getForumMembers')))
      .then(() => metric.logUserRequest(req.body.id, 'getForumMembers'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getForumMembers', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage('Server error getting forum members', errorHandler.EXCEPTION);
      });
  });
});

// CREATORS
// ------------------------------------------------------------------------------------

// Submits a new post
router.post('/createPost', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.title) {
      return errorHandler.handleErrorMessage(res, 'No title given', errorHandler.BAD_INPUT);
    } else if (!req.body.category) {
      return errorHandler.handleErrorMessage(res, 'No category given', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'No city id given', errorHandler.NO_LOCATION);
    } else if (req.body.cityId === -1) {
      return errorHandler.handleErrorMessage(res, 'User is not within a university region and cannot post', errorHandler.BAD_REQUEST);
    }
    if (!req.body.description) {
      req.body.description = '';
    }
    r.db('user').table('users')
      .get(req.body.id)
      .run()
      .then(function(userData) {
        if (!userData) {
          return errorHandler.handleErrorMessage(res, 'User does not exist in the database', errorHandler.BAD_REQUEST);
        }
        return r.db('forum').table('content')
          .insert({
            title: req.body.title,
            description: req.body.description,
            tsCreated: Date.now(),
            type: 'post',
            creator: req.body.id,
            creatorName: userData.name.split(' ')[0],
            photoId: userData.photoId,
            comments: 0,
            votes: 0,
            voteList: [],
            category: req.body.category,
            cityId: req.body.cityId,
            regionId: req.body.regionId,
            startDate: 0,  //Why is this here?
            photoUrl: req.body.photoUrl,
            url: req.body.url,
            urlImage: req.body.urlImage,
            photo: req.body.photo ? true : false,
            heuristic: 1,
            lastHeuristicUpdate: Date.now()
          })
          .run()
          .then(function afterPostInsertion(result) {
            if (result.generated_keys.length !== 0) {
              var retObject = {message: 'Successfully created post'};
              retObject.type = 'ok';
              retObject.postId = result.generated_keys[0];
              if (req.body.photo) {
                s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: result.generated_keys[0] + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, url) {
                  if (err) {
                    winston.error(err, {user: req.body.id, endpoint: 'createPost', type: errorHandler.NO_CHANGE});
                    return errorHandler.handleErrorMessage(res, 'Able to create post but not get photo upload urls', errorHandler.NO_CHANGE);
                  }
                  retObject.fullPhotoUrl = url;
                  s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: 'thumb_' + result.generated_keys[0] + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, smallUrl) {
                    if (err) {
                      winston.error(err, {user: req.body.id, endpoint: 'createPost', type: errorHandler.NO_CHANGE});
                      return errorHandler.handleErrorMessage(res, 'Able to create post but not get photo upload urls', errorHandler.NO_CHANGE);
                    }
                    retObject.thumbnailUrl = smallUrl;
                    res.status(200).send(JSON.stringify(retObject, null, 2));
                    metric.checkTotal(function() {
                      metric.updateTable('totals', {totalPosts: 1});
                    });
                    return updateRecognitionValues();
                  });
                });
              } else {
                res.status(200).send(JSON.stringify(retObject, null, 2));
                metric.checkTotal(function() {
                  metric.updateTable('totals', {totalPosts: 1});
                })
                return updateRecognitionValues();
              }

              function updateRecognitionValues() {
                insertRecognitionHistory('You created a post', req.body.id, 5, result.generated_keys[0], 'createPost');
                return r.db('user').table('users')
                  .get(req.body.id)
                  .update({recognition: r.row('recognition').add(5)})
                  .run()
                  .then(function(result) {
                    if (result.replaced === 0) {
                      winston.error('Unable to add recognition to user', {user: req.body.id, endpoint: 'createPost', type: errorHandler.NO_CHANGE});
                    }
                  });
              }
            } else {
              winston.error('ERROR: could not create post. Result: ' + JSON.stringify(res),
                {user: req.body.id, endpoint: 'createPost', type: errorHandler.NO_CHANGE});
              return errorHandler.handleErrorMessage(res, 'Server error creating post', errorHandler.NO_CHANGE);
            }
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('createPost')))
      .then(() => metric.logUserRequest(req.body.id, 'createPost'))
      .catch(function creationError(err) {
        winston.error(err, {user: req.body.id, endpoint: 'createPost', trace: stackTrace.parse(err)});
        return errorHandler.handleErrorMessage(res, 'Error inserting post');
      });
  });
});

// Submits a new comment
router.post('/createComment', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.message) {
      return errorHandler.handleErrorMessage(res, 'No message given', errorHandler.BAD_INPUT);
    } else if (!req.body.postId) {
      return errorHandler.handleErrorMessage(res, 'No post id given', errorHandler.BAD_INPUT);
    } else if (!req.body.postType) {
      return errorHandler.handleErrorMessage(res, 'No post type given', errorHandler.BAD_INPUT);
    }
    r.db('user').table('users')
      .get(req.body.id)
      .run()
      .then(function(userData) {
        if (!userData) {
          return errorHandler.handleErrorMessage(res, 'User does not exist in the database', errorHandler.BAD_REQUEST);
        }
        // TODO: add branch to support ancestor propagation
        if (!req.body.parentCommentId) {
          return r.db('forum').table('comments')
            .insert({
              datetime: Date.now(),
              message: req.body.message,
              commenter: req.body.id,
              commenterName: userData.name.split(' ')[0],
              commenterFullName: userData.name,
              photoId: userData.photoId,
              postId: req.body.postId,
              postType: req.body.postType,
              parentId: null,
              votes: 0,
              voteList: [],
              comments: 0,
              ancestors: []
            })
            .run()
        } else {
          return r.db('forum').table('comments')
            .get(req.body.parentCommentId)
            .run()
            .then(function(comment) {
              if (!comment) {
                return errorHandler.handleErrorMessage(res, 'Given parent comment does not exist', errorHandler.BAD_REQUEST);
              }
              comment.ancestors.push(comment.id);
              return r.db('forum').table('comments')
                .insert({
                  datetime: Date.now(),
                  message: req.body.message,
                  commenter: req.body.id,
                  commenterName: userData.name.split(' ')[0],
                  commenterFullName: userData.name,
                  photoId: userData.photoId,
                  postId: req.body.postId,
                  postType: req.body.postType,
                  parentId: req.body.parentCommentId,
                  votes: 0,
                  voteList: [],
                  comments: 0,
                  ancestors: comment.ancestors
                })
                .run()
            })
        }
      })
      .then(function(resolution) {
        if (!resolution || resolution.generated_keys.length === 0) {
          return errorHandler.handleErrorMessage(res, 'Could not insert comment', errorHandler.NO_CHANGE);
        }
        var commentId = resolution.generated_keys[0];
        var retObject = {message: 'Successfully created comment'};
        retObject.type = 'ok';
        retObject.commentId = commentId;
        res.status(200).send(JSON.stringify(retObject, null, 2));

        metric.checkTotal(function() {
          metric.updateTable('totals', {totalComments: 1});
        });

        return r.db('forum').table('content')
          .get(req.body.postId)
          .run()
          .then(function(result) {
            if (result.type !== 'rally') {
              if (!req.body.parentCommentId && result.creator !== req.body.id) {
                if (!result.isFromFeed) { // filter out comment notifications for feeds
                  insertRecognitionHistory('You received a comment on a post', result.creator, 1, result.id, 'createComment');
                }
                return r.db('user').table('users')
                  .get(result.creator)
                  .update({recognition: r.row('recognition').add(1)})
                  .run()
                  .then(function(result) {
                    if (result.replaced === 0) {
                      winston.error('Unable to add recognition to user', {user: result.creator, endpoint: 'createComment', type: errorHandler.NO_CHANGE});
                    }
                  });
              } else if (req.body.parentCommentId) {
                return r.db('forum').table('comments')
                  .get(req.body.parentCommentId)
                  .run()
                  .then(function(result) {
                    if (result.commenter !== req.body.id) {
                      insertRecognitionHistory('You received a reply to your comment', result.commenter, 1, result.id, 'createComment');
                      return r.db('user').table('users')
                        .get(result.commenter)
                        .update({recognition: r.row('recognition').add(1)})
                        .run()
                        .then(function(result) {
                          if (result.replaced === 0) {
                            return winston.error('Unable to add recognition to user', {user: result.commenter, endpoint: 'createComment', type: errorHandler.NO_CHANGE});
                          }
                        });
                    }
                  });
              }
            }
          })
          .then(function() {
            return r.db('forum').table('content')
              .get(req.body.postId)
              .run()
              .then(postData => {
                postData.comments++;
                postData.heuristic = heuristicService.getHeuristic(postData);

                return r.db('forum').table('content')
                  .get(req.body.postId)
                  .update({
                    comments: postData.comments,
                    heuristic: postData.heuristic
                  })
                  .run()
                  .then(function() {
                    if (req.body.parentCommentId) {
                      return r.db('forum').table('comments')
                        .get(req.body.parentCommentId)
                        .getField('commenter')
                        .run()
                        .then(function(commenter) {
                          return r.db('forum').table('content')
                            .get(req.body.postId)
                            .pluck('confirmedUsers', 'creator', 'members', 'type', 'isFromFeed')
                            .run()
                            .then(function(content) {
                              if (content.type !== 'rally') {
                                if (commenter !== req.body.id && !content.isFromFeed) {
                                  notify.createNotification(r, req.body.id, commenter, 'newComment', req.body.postId);
                                }
                              } else {
                                return r.db('forum').table('rallyInvites')
                                  .getAll(req.body.postId, {index: 'rallyId'})
                                  .filter({isPending: true})
                                  .getField('to')
                                  .coerceTo('array')
                                  .run()
                                  .then(invitedUsers => {
                                    content.confirmedUsers.forEach(function(user) {
                                      if (user !== req.body.id) {
                                        notify.createNotification(r, req.body.id, user, 'newRallyComment', req.body.postId, false);
                                      }
                                    });
                                    content.members.forEach(function(user) {
                                      if (user !== req.body.id) {
                                        notify.createNotification(r, req.body.id, user, 'newRallyComment', req.body.postId, false);
                                      }
                                    });
                                    invitedUsers.forEach(function(user) {
                                      if (user !== req.body.id) {
                                        notify.createNotification(r, req.body.id, user, 'newRallyComment', req.body.postId, false);
                                      }
                                    });
                                    return r.db('forum').table('content')
                                      .get(req.body.postId)
                                      .update({lastModified: Date.now()})
                                      .run()
                                      .then(function(result) {
                                        if (result.replaced === 0) {
                                          winston.error('Unable to update last modified', {user: req.body.id, endpoint: 'createComment', type: errorHandler.NO_CHANGE});
                                        }
                                      });
                                  })
                              }
                            });
                        })
                    } else {
                      return r.db('forum').table('content')
                        .get(req.body.postId)
                        .pluck('confirmedUsers', 'creator', 'members', 'type', 'isFromFeed')
                        .run()
                        .then(function(result) {
                          if (result.type !== 'rally') {
                            if (result.creator !== req.body.id && !result.isFromFeed) {
                              notify.createNotification(r, req.body.id, result.creator, 'newContentComment', req.body.postId);
                            }
                          } else {
                            return r.db('forum').table('rallyInvites')
                              .getAll(req.body.postId, {index: 'rallyId'})
                              .filter({isPending: true})
                              .getField('to')
                              .coerceTo('array')
                              .run()
                              .then(invitedUsers => {
                                result.confirmedUsers.forEach(function(user) {
                                  if (user !== req.body.id) {
                                    notify.createNotification(r, req.body.id, user, 'newRallyComment', req.body.postId, false);
                                  }
                                });
                                result.members.forEach(function(user) {
                                  if (user !== req.body.id) {
                                    notify.createNotification(r, req.body.id, user, 'newRallyComment', req.body.postId, false);
                                  }
                                });
                                invitedUsers.forEach(function(user) {
                                  if (user !== req.body.id) {
                                    notify.createNotification(r, req.body.id, user, 'newRallyComment', req.body.postId, false);
                                  }
                                });
                                return r.db('forum').table('content')
                                  .get(req.body.postId)
                                  .update({lastModified: Date.now()})
                                  .run()
                                  .then(function(result) {
                                    if (result.replaced === 0) {
                                      winston.error('Unable to update last modified', {user: req.body.id, endpoint: 'createComment', type: errorHandler.NO_CHANGE});
                                    }
                                  });
                              });
                          }
                        })
                    }
                  })
              })
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('createComment')))
      .then(() => metric.logUserRequest(req.body.id, 'createComment'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'createComment', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Unable to insert new comment', errorHandler.EXCEPTION);
      });
  });
});

// UPDATERS
// -------------------------------------------------------------------------------------

// Updates a forum or a post
router.post('/updatePost', function updateForumObj(req, res) {
  var updateObject = {};
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.postId) {
      return errorHandler.handleErrorMessage(res, 'No forumId given', errorHandler.BAD_INPUT);
    }
    if (req.body.description) {
      updateObject.description = req.body.description;
    }
    if (typeof req.body.url !== 'undefined') {
      updateObject.url = req.body.url;
      if (req.body.urlImage) {
        updateObject.urlImage = req.body.urlImage;
      }
    } else {
      updateObject.url = '';
      updateObject.urlImage = '';
    }
    if (req.body.photo) {
      updateObject.photo = true;
    }
    r.db('forum').table('content')
      .get(req.body.postId)
      .run()
      .then(function checkOwner(result) {
        if (!result) {
          return errorHandler.handleErrorMessage(res, 'Post does not exist', errorHandler.BAD_REQUEST);
        } else if (result.creator !== req.body.id) {
          return errorHandler.handleErrorMessage(res, 'User is not the owner of the post', errorHandler.BAD_REQUEST);
        }
        updateObject.lastHeuristicUpdate = Date.now();
        updateObject.heuristic = heuristicService.getHeuristic(result);
        return r.db('forum').table('content')
          .get(req.body.postId)
          .update(updateObject)
          .run()
          .then(function afterForumUpdate(result) {
            if (result.replaced.length === 0) {
              return errorHandler.handleErrorMessage(res, 'Unable to update post', errorHandler.NO_CHANGE);
            }
            var retObject = {message: 'Successfully updated post'};
            retObject.type = 'ok';

            if (req.body.photo) {
              s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: req.body.postId + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, url) {
                if (err) {
                  winston.error(err, {user: req.body.id, endpoint: 'updateEvent', type: errorHandler.NO_CHANGE});
                  return errorHandler.handleErrorMessage(res, 'Able to update post but not get photo upload urls', errorHandler.NO_CHANGE);
                }
                retObject.fullPhotoUrl = url;
                s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: 'thumb_' + req.body.postId + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, smallUrl) {
                  if (err) {
                    winston.error(err, {user: req.body.id, endpoint: 'updateEvent', type: errorHandler.NO_CHANGE});
                    return errorHandler.handleErrorMessage(res, 'Able to update post but not get photo upload urls', errorHandler.NO_CHANGE);
                  }
                  retObject.thumbnailUrl = smallUrl;
                  res.status(200).send(JSON.stringify(retObject, null, 2));

                  // Invalidate Cache
                  var params = {
                    DistributionId: config.cloudfrontDistributionId,
                    InvalidationBatch: {
                      CallerReference: req.body.postId + ':' + Date.now().toString(),
                      Paths: {
                        Quantity: 2,
                        Items: [
                          '/' + config.awsBucket + '/' + req.body.postId + '.jpg',
                          '/' + config.awsBucket +'/thumb_' + req.body.postId + '.jpg'
                        ]
                      }
                    }
                  }
                  cloudfront.createInvalidation(params, function(err, data) {
                    if (err) {
                      winston.error('Problem invalidating content: ' + JSON.stringify(err),
                        {user: req.body.id, endpoint: 'updateEvent', trace: stackTrace.parse(err), type: errorHandler.NO_CHANGE});
                    }
                  });
                });
              });
            } else {
              res.status(200).send(JSON.stringify(retObject, null, 2));
            }
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('updatePost')))
      .then(() => metric.logUserRequest(req.body.id, 'updatePost'))
      .catch(function checkError(err) {
        winston.error(err, {user: req.body.id, endpoint: 'updatePost', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Encountered error updating post', errorHandler.EXCEPTION);
      });
  });
});

// Submits a new comment
router.post('/updateComment', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.message) {
      return errorHandler.handleErrorMessage(res, 'No message given', errorHandler.BAD_INPUT);
    } else if (!req.body.commentId) {
      return errorHandler.handleErrorMessage(res, 'No comment id given', errorHandler.BAD_INPUT);
    }

    r.db('forum').table('comments')
      .get(req.body.commentId)
      .getField('commenter')
      .eq(req.body.id)
      .run()
      .then(function checkOwner(result) {
        if (!result) {
          return errorHandler.handleErrorMessage(res, 'User is not the owner of the comment', errorHandler.BAD_REQUEST);
        }
        return r.db('forum').table('comments')
          .get(req.body.commentId)
          .update({
            message: req.body.message
          })
          .run()
          .then(function(resolution) {
            if (resolution.replaced === 0) {
              return errorHandler.handleErrorMessage(res, 'Comment data did not change', errorHandler.NO_CHANGE);
            }
            var retObject = {message: 'Successfully updated comment'};
            retObject.type = 'ok';
            res.status(200).send(JSON.stringify(retObject, null, 2));
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('updateComment')))
      .then(() => metric.logUserRequest(req.body.id, 'updateComment'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'updateComment', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Encountered error updating comment', errorHandler.EXCEPTION);
      });
  });
});

// Submits a new comment
router.post('/deleteComment', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.commentId) {
      return errorHandler.handleErrorMessage(res, 'No comment id given', errorHandler.BAD_INPUT);
    } else if (!req.body.postId) {
      return errorHandler.handleErrorMessage(res, 'No post id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('comments')
      .get(req.body.commentId)
      .run()
      .then(function checkOwner(result) {
        if (result.commenter !== req.body.id) {
          return errorHandler.handleErrorMessage(res, 'User is not the owner of the comment', errorHandler.BAD_REQUEST);
        }
        return r.db('user').table('recognitionHistory')
          .getAll(req.body.commentId, {index: 'typeId'})
          .filter(function(row) {
            return row('type').eq('You received a reply to your comment').or(row('type').eq('Your comment was upvoted'));
          })
          .delete()
          .run()
          .then(function() {
            return r.db('forum').table('comments')
              .getAll(req.body.commentId, {index: 'parentId'})
              .count()
              .run()
              .then(function(commentCount) {
                return r.db('user').table('users')
                  .get(req.body.id)
                  .update({recognition: r.row('recognition').add(- result.votes -  commentCount)})
                  .run()
                  .then(function(outcome) {
                    if (outcome.replaced === 0 && (commentCount || result.votes)) {
                      winston.error('Unable to remove recognition from user during deletion of comment', {user: req.body.id, endpoint: 'deleteComment', type: errorHandler.NO_CHANGE});
                    }
                    rDeleteComments(req.body.commentId, req.body.postId);
                  })
              });
          })
          .then(function deleteComment() {
            return r.db('forum').table('comments')
              .get(req.body.commentId)
              .delete()
              .run()
              .then(function(resolution) {
                if (resolution.deleted === 0) {
                  return errorHandler.handleErrorMessage(res, 'Comment was unable to be deleted', errorHandler.NO_CHANGE);
                }
                var retObject = {message: 'Successfully deleted comment'};
                retObject.type = 'ok';
                res.status(200).send(JSON.stringify(retObject, null, 2));

                metric.checkTotal(function() {
                  metric.updateTable('totals', {totalComments: -1});
                })
              })
          })
          .then(function decrementCommentCount() {
            return r.db('forum').table('content')
              .get(req.body.postId)
              .update({
                comments: r.row('comments').add(-1)
              })
              .run()
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deleteComment')))
      .then(() => metric.logUserRequest(req.body.id, 'deleteComment'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'deleteComment', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Encountered error deleting comment', errorHandler.EXCEPTION);
      });
  });
});

function rDeleteComments(commentId, postId) {
  r.db('forum').table('comments')
    .getAll(postId, {index: 'postId'})
    .filter({parentId: commentId})
    .coerceTo('array')
    .run()
    .then(function(result) {
      for(var i in result) {
        rDeleteComments(result[i].id, postId);
      }
      metric.updateTable('totals', {totalComments: result.length * -1});
      return result;
    })
    .then(function(result) {
      return r.db('forum').table('content')
        .get(postId)
        .update({
          comments: r.row('comments').add(result.length * -1)
        })
        .run()
        .catch(function(err) {
          winston.error(err, {endpoint: 'func_rDeleteComments', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
        });
    })
    .then(function() {
      if (commentId) {
        return r.db('forum').table('comments')
          .getAll(commentId, {index: 'parentId'})
          .delete()
          .run()
          .catch(function(err) {
            winston.error(err, {endpoint: 'func_rDeleteComments', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
          });
      } else {
        return;
      }
    })
    .then(function() {
      if (commentId) {
        return r.db('user').table('recognitionHistory')
          .getAll(commentId, {index: 'typeId'})
          .filter(function(row) {
            return row('type').eq('You received a reply to your comment').or(row('type').eq('You received a comment on a post'));
          })
          .update({hidden: true})
          .run()
      } else {
        return;
      }
    })
    .catch(function(err) {
      winston.error(err, {endpoint: 'func_rDeleteComments', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
    });
}

// Delete a post
router.post('/deletePost', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.postId) {
      return errorHandler.handleErrorMessage(res, 'No post id given', errorHandler.BAD_INPUT);
    }

    r.db('forum').table('content')
      .get(req.body.postId)
      .run()
      .then(function checkOwner(result) {
        if (result.creator !== req.body.id) {
          return errorHandler.handleErrorMessage(res, 'User is not the owner of the post', errorHandler.BAD_REQUEST);
        }
        return r.db('user').table('recognitionHistory')
          .getAll(req.body.postId, {index: 'typeId'})
          .filter(function(row) {
            return row('type').eq('You received a comment on a post').or(row('type').eq('Your post was upvoted'));
          })
          .delete()
          .run()
          .then(function() {
            return r.db('forum').table('comments')
              .getAll(req.body.postId, {index: 'postId'})
              .filter({parentId: null})
              .count()
              .run()
              .then(function(commentCount) {
                return r.db('user').table('users')
                  .get(req.body.id)
                  .update({recognition: r.row('recognition').add((result.votes ? (-1 * result.votes) : 0) - commentCount)})
                  .run()
                  .then(function(outcome) {
                    if (outcome.replaced === 0 && (commentCount || result.votes)) {
                      winston.error('Unable to remove recognition from user during deletion of post', {user: req.body.id, endpoint: 'deletePost', type: errorHandler.NO_CHANGE});
                    }
                    rDeleteComments(null, req.body.postId);
                  })
              });
          })
          .then(function removeNotifications() {
            return r.db('notification').table('events')
              .getAll(req.body.postId, {index: 'item'})
              .filter(function(note) {
                return r.expr(['rallyInvite', 'rallyInviteAccepted', 'rallyRequest', 'rallyRequestAccepted',
                  'rallyAttendanceConfirmed', 'unconfirmRallyAttendance', 'leftRally', 'newRallyComment']).contains(note('type'));
              })
              .update({viewed: true})
              .run()
          })
          .then(function deletePost() {
            return r.db('forum').table('content')
              .get(req.body.postId)
              .delete()
              .run()
              .then(function(result) {
                if (result.deleted === 0) {
                  winston.error('Unable to delete post: ' + JSON.stringify(result), {user: req.body.id, endpoint: 'deletePost', type: errorHandler.NO_CHANGE});
                  errorHandler.handleErrorMessage(res, 'Post was unable to be deleted', errorHandler.NO_CHANGE);
                  return;
                }
                var retObject = {message: 'Successfully deleted post'};
                retObject.type = 'ok';
                res.status(200).send(JSON.stringify(retObject, null, 2));

                metric.checkTotal(function() {
                  metric.updateTable('totals', {totalPosts: -1});
                })
              })
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deletePost')))
      .then(() => metric.logUserRequest(req.body.id, 'deletePost'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'deletePost', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Serious server error trying to delete post', errorHandler.EXCEPTION);
      });
  });
});

router.post('/submitUpvote', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
    } else if (!req.body.forumId) {
      return errorHandler.handleErrorMessage(res, 'No forum id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('content')
      .get(req.body.forumId)
      .run()
      .then(function(result) {
        if (result.voteList.indexOf(req.body.id) !== -1) {
          return errorHandler.handleErrorMessage(res, 'Already voted', errorHandler.NO_CHANGE);
        }
        result.votes++;
        var heuristic = heuristicService.getHeuristic(result);
        return r.db('forum').table('content')
          .get(req.body.forumId)
          .update({
            votes: r.row('votes').add(1),
            voteList: r.row('voteList').setInsert(req.body.id),
            lastHeuristicUpdate: Date.now(),
            heuristic: heuristic
          })
          .run()
          .then(function(result) {
            if (result.replaced === 0) {
              return errorHandler.handleErrorMessage(res, 'Already voted', errorHandler.NO_CHANGE);
            }
            var retObject = {message: 'Successfully submitted vote'};
            retObject.type = 'ok';
            res.status(200).send(JSON.stringify(retObject, null, 2));

            return r.db('forum').table('content')
              .get(req.body.forumId)
              .run()
              .then(function(result) {
                insertRecognitionHistory('Your post was upvoted', result.creator, 1, req.body.forumId, 'submitUpvote');
                r.db('user').table('users')
                  .get(result.creator)
                  .update({recognition: r.row('recognition').add(1)})
                  .run()
                  .then(function(result) {
                    if (result.replaced === 0) {
                      winston.error('Unable to add recognition to user', {user: req.body.id, endpoint: 'submitUpvote', type: errorHandler.EXCEPTION});
                    }
                  });
              });
          });
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('submitUpvote')))
      .then(() => metric.logUserRequest(req.body.id, 'submitUpvote'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'submitUpvote', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Serious server error trying to submit upvote', errorHandler.EXCEPTION);
      });
  });
});

router.post('/deleteUpvote', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
    } else if (!req.body.forumId) {
      return errorHandler.handleErrorMessage(res, 'No forum id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('content')
      .get(req.body.forumId)
      .run()
      .then(function(post) {
        if (!post) {
          return errorHandler.handleErrorMessage(res, 'Content does not exist', errorHandler.BAD_REQUEST);
        } else if (!post.voteList || post.voteList.indexOf(req.body.id) === -1) {
          return errorHandler.handleErrorMessage(res, 'No existing vote to delete', errorHandler.BAD_REQUEST);
        }
        post.votes--;
        var heuristic = heuristicService.getHeuristic(post);
        return r.db('forum').table('content')
          .get(req.body.forumId)
          .update({
            voteList: r.row('voteList').deleteAt(post.voteList.indexOf(req.body.id)),
            votes: r.row('votes').add(-1),
            lastHeuristicUpdate: Date.now(),
            heuristic: heuristic
          })
          .run()
          .then(function(result) {
            if (result.replaced === 0) {
              return errorHandler.handleErrorMessage(res, 'Unable to delete upvote', errorHandler.NO_CHANGE);
            }

            var retObject = {message: 'Successfully deleted vote'};
            retObject.type = 'ok';
            res.status(200).send(JSON.stringify(retObject, null, 2));

            return r.db('forum').table('content')
              .get(req.body.forumId)
              .run()
              .then(function(result) {
                return r.db('user').table('users')
                  .get(result.creator)
                  .update({recognition: r.row('recognition').add(-1)})
                  .run()
                  .then(function(result) {
                    if (result.replaced === 0) {
                      winston.error('Unable to add recognition to user', {user: req.body.id, endpoint: 'deleteUpvote', type: errorHandler.NO_CHANGE});
                    }
                    return r.db('user').table('recognitionHistory')
                      .getAll(req.body.forumId, {index: 'typeId'})
                      .filter(function(item) {
                        return item('type').eq('Your post was upvoted');
                      })
                      .limit(1)
                      .delete()
                      .run()
                  });
              })
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deleteUpvote')))
      .then(() => metric.logUserRequest(req.body.id, 'deleteUpvote'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'deleteUpvote', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
      });
  });
});

// Including a postId will lead to a check for a question
router.post('/submitCommentUpvote', function(req, res) {
  var isQuestionAnswer = false;
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH)
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
    } else if (!req.body.commentId) {
      return errorHandler.handleErrorMessage(res, 'No comment id given', errorHandler.BAD_INPUT);
    } else {

      function insertVoteInDB() {
        return r.db('forum').table('comments')
          .get(req.body.commentId)
          .update({voteList: r.row('voteList').setInsert(req.body.id)})
          .run()
          .then(function(result) {
            if (result.replaced === 0) {
              return errorHandler.handleErrorMessage(res, 'Already voted', errorHandler.NO_CHANGE);
            }
            return r.db('forum').table('comments')
              .get(req.body.commentId)
              .update({votes: r.row('votes').add(isQuestionAnswer ? 5 : 1)})
              .run()
              .then(function(result) {
                if (result.replaced === 0) {
                  return errorHandler.handleErrorMessage(res, 'Already voted', errorHandler.NO_CHANGE);
                }
                var retObject = {message: 'Successfully submitted vote'};
                retObject.type = 'ok';
                res.status(200).send(JSON.stringify(retObject, null, 2));

                return r.db('forum').table('comments')
                  .get(req.body.commentId)
                  .run()
                  .then(function(result) {
                    insertRecognitionHistory('Your comment was upvoted', result.commenter, 1, req.body.commentId, 'submitCommentUpvote');
                    r.db('user').table('users')
                      .get(result.commenter)
                      .update({recognition: r.row('recognition').add(1)})
                      .run()
                      .then(function(result) {
                        if (result.replaced === 0) {
                          winston.error('Unable to add recognition to user', {user: req.body.id, endpoint: 'submitCommentUpvote', type: errorHandler.NO_CHANGE});
                        }
                      });
                  });
              });
          })
          .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
          .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('submitCommentUpvote')))
          .then(() => metric.logUserRequest(req.body.id, 'submitCommentUpvote'))
          .catch(function(err) {
            winston.error(err, {user: req.body.id, endpoint: 'submitCommentUpvote', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
            errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
          });
      }

      if (req.body.postId) {
        return r.db('forum').table('content')
          .get(req.body.postId)
          .pluck('creator', 'type')
          .run()
          .then(function(result) {
            if (result.creator !== req.body.id || result.type !== 'question') {
              return insertVoteInDB();
            } else {
              return r.db('forum').table('comments')
                .get(req.body.commentId)
                .pluck('commenter', 'parentId')
                .run()
                .then(function(comment) {
                  if (comment.commenter === req.body.id || comment.parentId !== null) {
                    return insertVoteInDB();
                  }
                  isQuestionAnswer = true;
                  return insertVoteInDB();
                });
            }
          })
          .catch(function(err) {
            winston.error(err, {user: req.body.id, endpoint: 'submitCommentUpvote', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
            errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
          });
      } else {
        return insertVoteInDB();
      }
    }
  });
});

router.post('/deleteCommentUpvote', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
    } else if (!req.body.commentId) {
      return errorHandler.handleErrorMessage(res, 'No comment id given', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('comments')
        .get(req.body.commentId)
        .run()
        .then(function(comment) {
          if (!comment) {
            return errorHandler.handleErrorMessage(res, 'No comment found to upvote', errorHandler.BAD_REQUEST)
          } else if (!comment.voteList || comment.voteList.indexOf(req.body.id) === -1) {
            return errorHandler.handleErrorMessage(res, 'No vote found to delete', errorHandler.BAD_REQUEST)
          }
          return r.db('forum').table('comments')
            .get(req.body.commentId)
            .update({voteList: r.row('voteList').deleteAt(comment.voteList.indexOf(req.body.id))})
            .run()
            .then(function(result) {
              if (result.replaced === 0) {
                return errorHandler.handleErrorMessage(res, 'Unable to delete upvote', errorHandler.NO_CHANGE);
              }
              return r.db('forum').table('comments')
                .get(req.body.commentId)
                .update({votes: r.row('votes').add(-1)})
                .run()
                .then(function(result) {
                  if (result.replaced === 0) {
                    return errorHandler.handleErrorMessage(res, 'Unable to delete upvote', errorHandler.NO_CHANGE);
                  }
                  var retObject = {message: 'Successfully deleted vote'};
                  retObject.type = 'ok';
                  res.status(200).send(JSON.stringify(retObject, null, 2));

                  return r.db('user').table('users')
                    .get(comment.commenter)
                    .update({recognition: r.row('recognition').add(-1)})
                    .run()
                    .then(function(result) {
                      if (result.replaced === 0) {
                        winston.error('Unable to add recognition to user', {user: req.body.id, endpoint: 'deleteUpvote', type: errorHandler.NO_CHANGE});
                      }
                      return r.db('user').table('recognitionHistory')
                        .getAll(req.body.commentId, {index: 'typeId'})
                        .filter(function(item) {
                          return item('type').eq('Your post was upvoted');
                        })
                        .limit(1)
                        .delete()
                        .run()
                    });
                })
            })
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deleteCommentUpvote')))
        .then(() => metric.logUserRequest(req.body.id, 'deleteCommentUpvote'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'deleteCommentUpvote', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Serious server issue', errorHandler.EXCEPTION);
        });
    }
  });
});

// Determines if the user is already following, then adds if not
router.post('/subscribeToForum', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
    } else if (!req.body.forumId) {
      return errorHandler.handleErrorMessage(res, 'No forum id given', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('membership')
        .getAll(req.body.forumId, {index: 'forumId'})
        .filter({'userId': req.body.id})
        .count()
        .run()
        .then(function(result) {
          if (result > 0) {
            return errorHandler.handleErrorMessage(res, 'User already follows this forum', errorHandler.BAD_REQUEST);
          } else {
            return r.db('forum').table('membership')
              .insert({
                userId: req.body.id,
                forumId: req.body.forumId
              })
              .run()
              .then(function(result) {
                if (result.inserted === 0) {
                  errorHandler.handleErrorMessage(res, 'Unable to subscribe to forum', errorHandler.NO_CHANGE);
                }
                var retObject = {message: 'Successfully gathered followed forum list'};
                retObject.type = 'ok';
                res.status(200).send(JSON.stringify(retObject, null, 2));
              })
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('subscribeToForum')))
        .then(() => metric.logUserRequest(req.body.id, 'subscribeToForum'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'subscribeToForum', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          return errorHandler.handleErrorMessage(res, 'Server error subscribing to forum', errorHandler.EXCEPTION);
        });
    }
  });
});

// Determines if the user is already following, then adds if not
router.post('/unsubscribeFromForum', function unsubscribeFromForum(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No id given', errorHandler.BAD_INPUT);
    } else if (!req.body.forumId) {
      return errorHandler.handleErrorMessage(res, 'No forum id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('membership')
      .getAll(req.body.forumId, {index: 'forumId'})
      .filter({'userId': req.body.id})
      .count()
      .run()
      .then(function(result) {
        if (result === 0) {
          return errorHandler.handleErrorMessage(res, 'User does not follow this forum', errorHandler.BAD_REQUEST);
        } else {
          return r.db('forum').table('membership')
            .getAll(req.body.forumId, {index: 'forumId'})
            .filter({'userId': req.body.id})
            .delete()
            .run()
            .then(function(result) {
              if (result.deleted === 0) {
                return errorHandler.handleErrorMessage(res, 'Unable to unsubscribing from forum', errorHandler.NO_CHANGE);
              }
              var retObject = {message: 'Successfully unsubscribed user'};
              retObject.type = 'ok';
              retObject.result = result;
              res.status(200).send(JSON.stringify(retObject, null, 2));
            })
        }
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('unsubscribeFromForum')))
      .then(() => metric.logUserRequest(req.body.id, 'unsubscribeFromForum'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'unsubscribeFromForum', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Server error unsubscribing from forum', errorHandler.EXCEPTION);
      });
  });
});

/*----------------------------- Supporting functions -----------------------------*/

function insertRecognitionHistory(type, userId, points, typeId, endpoint) {
  r.db('user').table('recognitionHistory')
    .insert({
      tsCreated: Date.now(),
      type: type,
      userId: userId,
      points: points,
      typeId: typeId
    })
    .run()
    .then(function(result) {
      if (result.inserted === 0) {
        winston.error('unable to insert recognition history', {user: userId, endpoint: endpoint});
      }
    })
    .catch(function(err) {
      winston.error(err, {user: userId, endpoint: endpoint, trace: stackTrace.parse(err)});
    });
}

module.exports = router;
