/*jslint node: true */
var config = rootRequire('config');
var r = require('rethinkdbdash')({servers: [config.rethinkdb]});
var express = require('express');
var auth = rootRequire('auth/auth.js');
var router = express.Router();
var winston = rootRequire('log');
var metric = rootRequire('metric');
var stackTrace = require('stack-trace');
var errorHandler = rootRequire('error');
var AWS = require('aws-sdk');
AWS.config.update(config.awsAccess);
var s3 = new AWS.S3();
var cloudfront = new AWS.CloudFront();
var heuristicService = rootRequire('tools/heuristic');
var mapper = rootRequire('tools/mappers');

// Create an event and the related post to the official category forum
// * Forum the event belongs in is optional
router.post('/createEvent', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.lng || !req.body.lat) {
      return errorHandler.handleErrorMessage(res, 'Missing location coordinates', errorHandler.NO_LOCATION);
    } else if (!req.body.startDate || !req.body.endDate) {
      return errorHandler.handleErrorMessage(res, 'Missing datetime information', errorHandler.BAD_INPUT);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing host ID', errorHandler.BAD_INPUT);
    } else if (!req.body.category) {
      return errorHandler.handleErrorMessage(res, 'Missing category', errorHandler.BAD_INPUT);
    } else if (!req.body.costs) {
      return errorHandler.handleErrorMessage(res, 'Missing array of costs', errorHandler.BAD_INPUT);
    } else if (!req.body.title) {
      return errorHandler.handleErrorMessage(res, 'Missing event title', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'Missing city ID', errorHandler.BAD_INPUT);
    } else if (req.body.cityId === -1) {
      return errorHandler.handleErrorMessage(res, 'User is not within a region and cannot post', errorHandler.BAD_REQUEST);
    } else {
      // Implement category lookup before this section
      r.db('user').table('users')
        .get(req.body.id)
        .run()
        .then(function(userData) {
          if (!userData) {
            return errorHandler.handleErrorMessage(res, 'User does not exist in the database', errorHandler.BAD_REQUEST);
          }
          var location = r.point(parseFloat(req.body.lng), parseFloat(req.body.lat));
          return r.db('util').table('regions')
           .getNearest(location, {index: 'location', maxDist: 75, unit: 'mi'})
           .limit(1)
           .coerceTo('array')
           .run()
           .then(region => {
             return r.db('forum').table('content')
               .insert({
                 title: req.body.title,
                 description: req.body.description || null,
                 tsCreated: Date.now(),
                 type: 'event',
                 creator: req.body.id,
                 creatorName: userData.name.split(' ')[0],
                 photoId: userData.photoId,
                 comments: 0,
                 votes: 0,
                 voteList: [],
                 startDate: req.body.startDate,
                 endDate: req.body.endDate,
                 location: location,
                 category: req.body.category,
                 costs: req.body.costs,
                 cityId: req.body.cityId,
                 regionId: region[0].doc.id,
                 address: req.body.address,
                 generalArea: req.body.generalArea,
                 links: req.body.links,
                 urlImage: req.body.urlImage,
                 photo: req.body.photo ? true : false,
                 heuristic: 1,
                 lastHeuristicUpdate: Date.now()
               })
             .run()
           })
      })
      .then(function(result) {
        if (result.generated_keys.length === 0) {
          return errorHandler.handleErrorMessage(res, 'User does not exist in the database', errorHandler.NO_CHANGE);
        }

        function recordRecognition() {
          insertRecognitionHistory('You created an event', req.body.id, 5, result.generated_keys[0], 'createEvent');
          return r.db('user').table('users')
            .get(req.body.id)
            .update({recognition: r.row('recognition').add(5)})
            .run()
            .then(function(result) {
              if (result.replaced === 0) {
                winston.error('Unable to add recognition to user', {user: req.body.id, endpoint: 'createEvent', type: errorHandler.NO_CHANGE});
              }
            });
        }

        var retObject = {message: 'Successfully created event'};
        retObject.type = 'ok';
        retObject.eventId = result.generated_keys[0];
        if (req.body.photo) {
          s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: result.generated_keys[0] + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, url) {
            if (err) {
              winston.error(err, {user: req.body.id, endpoint: 'createEvent', type: errorHandler.NO_CHANGE});
              return errorHandler.handleErrorMessage(res, 'Able to create event but not get photo upload urls', errorHandler.NO_CHANGE);
            }
            retObject.fullPhotoUrl = url;
            s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: 'thumb_' + result.generated_keys[0] + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, smallUrl) {
              if (err) {
                winston.error(err, {user: req.body.id, endpoint: 'createEvent', type: errorHandler.NO_CHANGE});
                return errorHandler.handleErrorMessage(res, 'Able to create event but not get photo upload urls', errorHandler.NO_CHANGE);
              }
              retObject.thumbnailUrl = smallUrl;
              res.status(200).send(JSON.stringify(retObject, null, 2));
              recordRecognition();
              metric.checkTotal(function() {
                metric.updateTable('totals', {totalEvents: 1});
              });
            });
          });
        } else {
          res.status(200).send(JSON.stringify(retObject, null, 2));
          recordRecognition();
          metric.checkTotal(function() {
            metric.updateTable('totals', {totalEvents: 1});
          });
        }
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('createEvent')))
      .then(() => metric.logUserRequest(req.body.id, 'createEvent'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, type: errorHandler.EXCEPTION, endpoint: 'createEvent', reqBody: req.body, trace: stackTrace.parse(err)});
        errorHandler.handleErrorMessage(res, 'Encountered error inserting event', errorHandler.EXCEPTION);
      });
    }
  });
});

function updateEventData(req, res, updateObject) {
  return r.db('forum').table('content')
    .get(req.body.eventId)
    .update(updateObject)
    .run()
    .then(function afterForumUpdate(result) {
      if (result.replaced.length !== 0) {
        var retObject = {message: 'Successfully updated event'};
        retObject.type = 'ok';

        if (req.body.photo) {
          s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: req.body.eventId + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, url) {
            if (err) {
              winston.error(err, {user: req.body.id, endpoint: 'updateEvent', type: errorHandler.NO_CHANGE});
              return errorHandler.handleErrorMessage(res, 'Able to update event but not get photo upload urls', errorHandler.NO_CHANGE);
            }
            retObject.fullPhotoUrl = url;
            s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: 'thumb_' + req.body.eventId + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, smallUrl) {
              if (err) {
                winston.error(err, {user: req.body.id, endpoint: 'updateEvent', type: errorHandler.NO_CHANGE});
                return errorHandler.handleErrorMessage(res, 'Able to update event but not get photo upload urls', errorHandler.NO_CHANGE);
              }
              retObject.thumbnailUrl = smallUrl;
              res.status(200).send(JSON.stringify(retObject, null, 2));

              // Invalidate Cache
              var params = {
                DistributionId: config.cloudfrontDistributionId,
                InvalidationBatch: {
                  CallerReference: req.body.eventId + ':' + Date.now().toString(),
                  Paths: {
                    Quantity: 2,
                    Items: [
                      '/' + config.awsBucket + '/' + req.body.eventId + '.jpg',
                      '/' + config.awsBucket + '/thumb_' + req.body.eventId + '.jpg'
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
      } else {
        return errorHandler.handleErrorMessage(res, 'Unable to update post', errorHandler.NO_CHANGE);
      }
    });
}

// Update existing events with a subset of a normal event's information
router.post('/updateEvent', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    var updateObject = {};
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.eventId) {
      return errorHandler.handleErrorMessage(res, 'Missing an event id on request', errorHandler.BAD_INPUT);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user ID', errorHandler.BAD_INPUT);
    }
    if (req.body.lng || req.body.lat) {
      if (!req.body.lng || !req.body.lat) {
        return errorHandler.handleErrorMessage(res, 'Missing lng or lat', errorHandler.NO_LOCATION);
      }
      updateObject.location = r.point(parseFloat(req.body.lng), parseFloat(req.body.lat));
    }
    if (req.body.startDate) {
      updateObject.startDate = req.body.startDate;
    }
    if (req.body.endDate) {
      updateObject.endDate = req.body.endDate;
    }
    if (req.body.category) {
      updateObject.category = req.body.category;
    }
    if (req.body.costs) {
      updateObject.costs = req.body.costs;
    }
    if (req.body.links) {
      updateObject.links = req.body.links;
    }
    if (req.body.description) {
      updateObject.description = req.body.description;
    }
    if (req.body.photo) {
      updateObject.photo = true;
    }
    if (req.body.address) {
      updateObject.address = req.body.address;
    }
    if (req.body.generalArea) {
      updateObject.generalArea = req.body.generalArea;
    }
    if (req.body.urlImage) {
      updateObject.urlImage = req.body.urlImage;
    }
    r.db('forum').table('content')
      .get(req.body.eventId)
      .run()
      .then(function checkOwner(eventToUpdate) {
        if (!eventToUpdate) {
          return errorHandler.handleErrorMessage(res, 'Event does not exist', errorHandler.BAD_REQUEST);
        } else if (eventToUpdate.creator !== req.body.id) {
          return errorHandler.handleErrorMessage(res, 'User is not the owner of the post', errorHandler.BAD_REQUEST);
        } else {
          updateObject.lastHeuristicUpdate = Date.now();
          updateObject.heuristic = heuristicService.getHeuristic(eventToUpdate);
          if (!updateObject.location) {
            return updateEventData(req, res, updateObject);
          } else {
            return r.db('util').table('regions')
             .getNearest(updateObject.location, {index: 'location', maxDist: 75, unit: 'mi'})
             .limit(1)
             .coerceTo('array')
             .run()
             .then(region => {
               updateObject.regionId = region.length > 0 ? region[0].doc.id : undefined;
               return updateEventData(req, res, updateObject);
             });
          }
        }
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('updateEvent')))
      .then(() => metric.logUserRequest(req.body.id, 'updateEvent'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, type: errorHandler.EXCEPTION, endpoint: 'updateEvent', reqBody: req.body, trace: stackTrace.parse(err)});
        errorHandler.handleErrorMessage(res, 'Encountered error updating event', errorHandler.EXCEPTION);
      });
  });
});

function rDeleteComments(commentId, eventId) {
  r.db('forum').table('comments')
    .getAll(eventId, {index: 'postId'})
    .filter({parentId: commentId})
    .coerceTo('array')
    .run()
    .then(function(result) {
      for(var i in result) {
        rDeleteComments(result[i].id, eventId);
      }
      metric.updateTable('totals', {totalComments: result.length * -1});
      return result;
    })
    .then(function(result) {
      return r.db('forum').table('content')
        .get(eventId)
        .update({
          comments: r.row('comments').add(result.length * -1)
        })
        .run()
    })
    .then(function() {
      if (commentId) {
        return r.db('forum').table('comments')
          .getAll(commentId, {index: 'parentId'})
          .delete()
          .run();
      } else {
        return;
      }
    })
    .catch(function(err) {
      winston.error(err, {endpoint: 'func_rDeleteComments', type: errorHandler.EXCEPTION, trace: stackTrace.parse(err)});
    });
}

// Delete an event
router.post('/deleteEvent', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.eventId) {
      return errorHandler.handleErrorMessage(res, 'No event id given', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('content')
      .get(req.body.eventId)
      .getField('creator')
      .eq(req.body.id)
      .run()
      .then(function checkOwner(result) {
        if (result) {
          return r
            .db('forum').table('content')
            .get(req.body.eventId)
            .delete()
            .run()
            .then(function(result) {
              if (result.deleted !== 0) {
                var retObject = {message: 'Successfully deleted event'};
                retObject.type = 'ok';
                res.status(200).send(JSON.stringify(retObject, null, 2));
                rDeleteComments(null, req.body.eventId);
                metric.checkTotal(function() {
                  metric.updateTable('totals', {totalEvents: -1});
                });
              } else {
                winston.error('Unable to delete event: ' + JSON.stringify(result),
                  {user: req.body.id, endpoint: 'deleteEvent', type: errorHandler.NO_CHANGE});
                return errorHandler.handleErrorMessage(res, 'Event was unable to be deleted', errorHandler.NO_CHANGE);
              }
            });
        } else {
          return errorHandler.handleErrorMessage(res, 'User is not the owner of the event', errorHandler.BAD_REQUEST);
        }
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deleteEvent')))
      .then(() => metric.logUserRequest(req.body.id, 'deleteEvent'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'deleteEvent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Unable to determine if user is the owner', errorHandler.EXCEPTION);
      });
  });
});

// Get events for a given time
router.post('/getEventsByTime', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.startDate || !req.body.endDate) {
      return errorHandler.handleErrorMessage(res, 'Missing datetime information', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'Missing city ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .getAll('event', {index: 'type'})
        .filter(r.row('startDate').le(parseInt(req.body.endDate)).and(r.row('endDate').ge(parseInt(req.body.startDate))))
        .pluck('id', 'category', 'startDate', 'endDate', 'location', 'title', 'generalArea', 'comments')
        .coerceTo('array')
        .run()
        .then(function(result) {
          var retObject = {message: 'Successfully gathered events'};
          retObject.type = 'ok';
          retObject.events = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getEventsByTime')))
        .then(() => metric.logUserRequest(req.body.id, 'getEventsByTime'))
        .catch(function(err) {
          winston.error(err, {endpoint: 'getEventsByTime', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Issue with database on getting events', errorHandler.EXCEPTION);
        });
    }
  });
});

// Get events for a given time and category
router.post('/getEventsByCategory', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.startDate || !req.body.endDate) {
      return errorHandler.handleErrorMessage(res, 'Missing datetime information', errorHandler.BAD_INPUT);
    } else if (!req.body.category) {
      return errorHandler.handleErrorMessage(res, 'Missing category', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'Missing city ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .getAll('event', {index: 'type'})
        .filter(r.row('startDate').le(parseInt(req.body.endDate)).and(r.row('endDate').ge(parseInt(req.body.startDate))))
        .without('creator')
        .coerceTo('array')
        .run()
        .then(function(result) {
          var retObject = {message: 'Successfully gathered events'};
          retObject.type = 'ok';
          retObject.events = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getEventsByCategory')))
        .then(() => metric.logUserRequest(req.body.id, 'getEventsByCategory'))
        .catch(function(err) {
          winston.error(err, {endpoint: 'getEventsByCategory', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Issue with database on getting events', errorHandler.EXCEPTION);
        });
    }
  });
});

// Get events for a given time
router.post('/getMapContentByTime', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.startDate || !req.body.endDate) {
      return errorHandler.handleErrorMessage(res, 'Missing datetime information', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'Missing city ID', errorHandler.BAD_INPUT);
    } else {
      var retObject = {};
      return r.db('forum').table('content')
        .getAll('event', {index: 'type'})
        .filter(r.row('startDate').le(parseInt(req.body.endDate)).and(r.row('endDate').ge(parseInt(req.body.startDate))))
        .without('creator')
        .coerceTo('array')
        .run()
        .then(function getMyRallies(result) {
          retObject.events = result;
          return r.db('forum').table('content')
            .getAll('rally', {index: 'type'})
            .filter(r.row('startDate').le(parseInt(req.body.endDate)).and(r.row('endDate').ge(parseInt(req.body.startDate))))
            .filter(r.row('confirmedUsers').contains(req.body.id).or(r.row('members').contains(req.body.id)))
            .union(
              r.db('forum').table('content')
                .getAll('rally', {index: 'type'})
                .filter(r.row('startDate').le(parseInt(req.body.endDate)).and(r.row('endDate').ge(parseInt(req.body.startDate))))
                .innerJoin(r.db('forum').table('rallyInvites'), function(rallyContent, invite) {
                  return rallyContent('id').eq(invite('rallyId')).and(invite('to').eq(req.body.id)).and(invite('isPending').eq(true))
                })
                .without({
                  right: ['id', 'to', 'rallyId', 'from'],
                  left: ['address', 'creator', 'declined', 'lastHeuristicUpdate', 'lastModified', 'requestCount']
                })
                .zip()
            )
            .distinct()
            .coerceTo('array')
            .run();
        })
        .then(function getPublicRallies(result) {
          retObject.myRallies = result.map(rallyData => mapper.mapRallyData(rallyData, req.body.id));
          var rallyIds = result.map(function(rally) {
            return rally.id;
          });
          return r.db('user').table('users')
            .get(req.body.id)
            .getField('contacts')
            .coerceTo('array')
            .run()
            .then(contacts => {
              return r.db('forum').table('content')
                .getAll('rally', {index: 'type'})
                .filter(function(rally) {
                  return rally('startDate').le(parseInt(req.body.endDate))
                    .and(rally('endDate').ge(parseInt(req.body.startDate)))
                    .and(r.expr(rallyIds).contains(rally('id')).not())
                    .and(rally('privacy').eq('public')
                      .or(rally('privacy').eq('protected')
                        .and(r.expr(contacts).contains(rally('creator')))))
                })
                .coerceTo('array')
                .run()
                .then(rallies => {
                  return rallies.map(rallyData => mapper.mapRallyData(rallyData, req.body.id));
                })
            })
        })
        .then(function(result) {
          retObject.message = 'Successfully gathered map content';
          retObject.type = 'ok';
          retObject.rallies = result;
          return res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getMapContentByTime')))
        .then(() => metric.logUserRequest(req.body.id, 'getMapContentByTime'))
        .catch(function(err) {
          winston.error(err, {endpoint: 'getMapContentByTime', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Issue with database on getting map content', errorHandler.EXCEPTION);
        });
    }
  });
});

// ---------------------------- Supporting Functions -------------------------------------------

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
        winston.error('unable to insert recognition history', {user: userId, endpoint: endpoint, type: errorHandler.NO_CHANGE});
      }
    })
    .catch(function(err) {
      winston.error(err, {user: userId, endpoint: endpoint, trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
    });
}

module.exports = router;
