/*globals rootRequire */
var config = rootRequire('config').rethinkdb;
var r = require('rethinkdbdash')({servers: [config]});
var auth = rootRequire('auth/auth.js');
var express = require('express');
var router = express.Router();
var winston = rootRequire('log');
var metric = rootRequire('metric');
var stackTrace = require('stack-trace');
var R = require('ramda');
var notify = rootRequire('tools/notify');
var heuristicService = rootRequire('tools/heuristic');
var mapper = rootRequire('tools/mappers');
var locationService = rootRequire('tools/location');
var errorHandler = rootRequire('error');

// Create rally
router.post('/createRally', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing host ID', errorHandler.BAD_INPUT);
    } else if (!req.body.title) {
      return errorHandler.handleErrorMessage(res, 'Missing event title', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'Missing city ID', errorHandler.BAD_INPUT);
    } else  if (!req.body.lng || !req.body.lat)  {
      return errorHandler.handleErrorMessage(res, 'Missing lng or lat', errorHandler.NO_LOCATION);
    } else if (req.body.cityId === -1) {
      return errorHandler.handleErrorMessage(res, 'User is not within a region and cannot post', errorHandler.BAD_REQUEST);
    } else {
      if (!req.body.privacy) {
        req.body.privacy = 'public';
      }
      var rallyObj = {
        title: req.body.title,
        tsCreated: Date.now(),
        lastModified: Date.now(),
        cityId: req.body.cityId,
        type: 'rally',
        voteList: [], // this will never get populated
        creator: req.body.id,
        comments: 0,
        members: [],
        requests: [],
        declined: [],
        confirmedUsers: [req.body.id],
        privacy: req.body.privacy,
        heuristic: 0,
        lastHeuristicUpdate: Date.now(),
        requestCount: 0,
        declinedCount: 0
      };
      if (req.body.description) {
        rallyObj.description = req.body.description;
      }
      if (req.body.startDate) {
        rallyObj.startDate = req.body.startDate;
      }
      if (req.body.endDate) {
        rallyObj.endDate = req.body.endDate;
      }
      if (req.body.category) {
        rallyObj.category = req.body.category;
      }
      if (req.body.address) {
        rallyObj.address = req.body.address;
      }
      if (req.body.requirements) {
        rallyObj.requirements = req.body.requirements;
      }
      if (req.body.generalArea) {
        rallyObj.generalArea = req.body.generalArea;
      }

      var offset = locationService.getMileOffsets();
      // TODO: remove location when all users are off the university version of YoRally
      rallyObj.location = r.point(parseFloat(req.body.lng) + offset.publicLngOffset, parseFloat(req.body.lat) + offset.publicLatOffset);
      rallyObj.publicLocation = r.point(parseFloat(req.body.lng) + offset.publicLngOffset, parseFloat(req.body.lat) + offset.publicLatOffset);
      rallyObj.privateLocation = r.point(parseFloat(req.body.lng), parseFloat(req.body.lat));

      r.db('user').table('users')
        .get(req.body.id)
        .run()
        .then(function(userData) {
          if (!userData) {
            return errorHandler.handleErrorMessage(res, 'User does not exist in the database', errorHandler.BAD_REQUEST);
          }
          rallyObj.creatorFullName = userData.name;
          rallyObj.creatorName = userData.name.split(' ')[0];
          rallyObj.photoId = userData.photoId;
          return r.db('util').table('regions')
           .getNearest(rallyObj.privateLocation, {index: 'location', maxDist: 75, unit: 'mi'})
           .limit(1)
           .coerceTo('array')
           .run()
           .then(region => {
             console.log(region);
             rallyObj.regionId = region[0].doc.id;
             return r.db('forum').table('content')
               .insert(rallyObj)
               .run()
               .then(function(result) {
                 if (result.generated_keys.length === 0) {
                   return errorHandler.handleErrorMessage(res, 'Unable to insert rally into database', '/createRally', errorHandler.NO_CHANGE);
                 }
                 var retObject = {message: 'Successfully created rally'};
                 retObject.type = 'ok';
                 retObject.rallyId = result.generated_keys[0];
                 res.status(200).send(JSON.stringify(retObject, null, 2));

                 var pts = 5;
                 if (req.body.privacy === 'public') {
                   pts = 15;
                 }
                 insertRecognitionHistory('You created a rally', req.body.id, pts, result.generated_keys[0], 'createRally');
                 return r.db('user').table('users')
                   .get(req.body.id)
                   .update({recognition: r.row('recognition').add(pts)})
                   .run()
                   .then(function(resolution) {
                     if (resolution.replaced === 0) {
                       return winston.error('Unable to add recognition to user', {user: req.body.id, endpoint: 'createRally', type: errorHandler.NO_CHANGE});
                     }

                     if (req.body.invited && req.body.invited.length) {
                       req.body.invited.forEach(function inviteUser(userId) {
                         return r.db('forum').table('rallyInvites')
                           .insert({
                             from: req.body.id,
                             to: userId,
                             rallyId: result.generated_keys[0],
                             isPending: true
                           })
                           .run()
                           .then(function(invited) {
                             if (invited.inserted === 0) {
                               winston.error('ERROR: could not invite user successfully: ' + JSON.stringify(invited),
                                 {user: req.body.id, endpoint: 'createRally', type: errorHandler.NO_CHANGE});
                             } else {
                               notify.createNotification(r, req.body.id, userId, 'rallyInvite', result.generated_keys[0]);
                             }
                           })
                           .catch(function(err) {
                             winston.error(err, {user: req.body.id, endpoint: 'createRally', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
                           });
                       });
                     }

                     if (req.body.deleteStatus) {
                       return r.db('user').table('status')
                         .get(req.body.id)
                         .delete()
                         .run()
                         .then(function(resolution) {
                           if (resolution.deleted === 0) {
                             winston.error('Unable to delete user status', {user: req.body.id, endpoint: 'createRally', type: errorHandler.NO_CHANGE});
                           }
                         });
                     }
                   });
               })
           })
        })
        .then(() => metric.checkTotal(() => metric.updateTable('totals', {totalRallies: 1})))
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('createRally')))
        .then(() => metric.logUserRequest(req.body.id, 'createRally'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'createRally', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error inserting rally', errorHandler.EXCEPTION);
        });
    }
  });
});

function updateRallyData(req, res, rally, updateString, updateObject, updatingUser) {
  return r.db('forum').table('content')
    .get(req.body.rallyId)
    .update(updateObject)
    .run()
    .then(function(result) {
      if (result.replaced.length === 0) {
        return errorHandler.handleErrorMessage(res, 'Unable to update rally on database', errorHandler.NO_CHANGE);
      } else {
        // Construct return object
        var retObject = {message: 'Successfully updated rally and notified users'};
        retObject.type = 'ok';

        if (req.body.address || req.body.lng || req.body.lat || req.body.startDate || req.body.sendDate) {
          // have all members re-confirm their attendance and notify them that important details changed
          return r.db('forum').table('content')
            .get(req.body.rallyId)
            .update(function(rally) {
              return r.object('confirmedUsers', [req.body.id],
                              'members', rally('confirmedUsers').setUnion(rally('members')).setDifference([req.body.id]));
            }, {returnChanges: true})
            .run()
            .then(function(changes) {
              if (changes.replaced === 0 && (rally.confirmedUsers.length + rally.members.length > 1)) {
                winston.error('Unable to have users re-confirm their commitment to the rally: ' + JSON.stringify(changes),
                  {user: req.body.id, endpoint: 'updateRally', type: errorHandler.NO_CHANGE});
              } else if (changes.replaced !== 0) {
                changes.changes[0].old_val.confirmedUsers.forEach(function(userId) {
                  if (userId !== rally.creator) {
                    notify.createNotification(r, req.body.id, userId, 'rallyUpdated', req.body.rallyId, false, true);
                  }
                });
              }
              return r.db('forum').table('comments')
                .insert({
                  datetime: Date.now(),
                  message: updateString,
                  commenter: req.body.id,
                  commenterName: updatingUser.name.split(' ')[0],
                  commenterFullName: updatingUser.name,
                  commenterImage: updatingUser.imageUrl,
                  postId: req.body.rallyId,
                  postType: 'rally',
                  parentId: null,
                  votes: 0,
                  voteList: [],
                  comments: 0,
                  ancestors: [],
                  updateComment: true
                })
                .run()
                .then(() => {
                  return res.status(200).send(JSON.stringify(retObject, null, 2));
                });
            })
        } else {
          return r.db('forum').table('comments')
            .insert({
              datetime: Date.now(),
              message: updateString,
              commenter: req.body.id,
              commenterName: updatingUser.name.split(' ')[0],
              commenterFullName: updatingUser.name,
              commenterImage: updatingUser.imageUrl,
              postId: req.body.rallyId,
              postType: 'rally',
              parentId: null,
              votes: 0,
              voteList: [],
              comments: 0,
              ancestors: [],
              updateComment: true
            })
            .run()
            .then(() => {
              return res.status(200).send(JSON.stringify(retObject, null, 2));
            });
        }
      }
    });
}

router.post('/updateRally', function updateForumObj(req, res) {
  var updateObject = {};
  var updateString = "";
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing host ID', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing rallyId', errorHandler.BAD_INPUT);
    }

    r.db('user').table('users')
      .get(req.body.id)
      .run()
      .then(updatingUser => {
        if (req.body.description) {
          updateObject.description = req.body.description;
          updateString += (updateString.length === 0 ? '' : ', ') + 'description';
        }
        if (req.body.startDate) {
          updateObject.startDate = req.body.startDate;
          updateString += (updateString.length === 0 ? '' : ', ') + 'start time';
        }
        if (req.body.endDate) {
          updateObject.endDate = req.body.endDate;
          updateString += (updateString.length === 0 ? '' : ', ') + 'end time';
        }
        // optional because location does not need to be updated
        if (req.body.lng || req.body.lat) {
          if (!req.body.lng || !req.body.lat) {
            return errorHandler.handleErrorMessage(res, 'Missing lng or lat', errorHandler.NO_LOCATION);
          }

          var offset = locationService.getMileOffsets();
          updateObject.location= r.point(parseFloat(req.body.lng) + offset.publicLngOffset, parseFloat(req.body.lat) + offset.publicLatOffset);
          updateObject.privateLocation= r.point(parseFloat(req.body.lng), parseFloat(req.body.lat));
          updateString += (updateString.length === 0 ? '' : ', ') + 'location';
        }
        if (req.body.category) {
          updateObject.category = req.body.category;
          updateString += (updateString.length === 0 ? '' : ', ') + 'category';
        }
        if (req.body.address) {
          updateObject.address = req.body.address;
          updateString += (updateString.length === 0 ? '' : ', ') + 'address';
        }
        if (req.body.generalArea) {
          updateObject.generalArea = req.body.generalArea;
        }
        if (req.body.requirements) {
          updateObject.requirements = req.body.requirements;
          updateString += (updateString.length === 0 ? '' : ', ') + 'requirements';
        }
        if (req.body.privacy) {
          updateObject.privacy = req.body.privacy;
          updateString += (updateString.length === 0 ? '' : ', ') + 'privacy';
        }
        updateObject.lastModified = Date.now();

        updateString = (updatingUser.name + ' updated: ' + updateString);

        return r.db('forum').table('content')
          .get(req.body.rallyId)
          .run()
          .then(function(rallyToUpdate) {
            if (!rallyToUpdate) {
              return
            } else if (rallyToUpdate.privacy !== req.body.privacy) {
              if ((rallyToUpdate.privacy === 'private' || rallyToUpdate.privacy === 'protected') && (req.body.privacy === 'private' || req.body.privacy === 'protected')) {
                return; // no need to change recognition
              } else {
                var ptsDiff = req.body.privacy === 'public' ? 10 : -10;
                return r.db('user').table('recognitionHistory')
                  .getAll(req.body.rallyId, {index: 'typeId'})
                  .filter({type: 'You created a rally'})
                  .update({points: r.row('points').add(ptsDiff)})
                  .run()
                  .then(function(result) {
                    if (result.replaced === 0) {
                      winston.error('Unable to adjust rally recognition reward', {user: req.body.id, endpoint: 'updateRally', type: errorHandler.NO_CHANGE});
                    }
                  })
                  .then(function() {
                    return r.db('user').table('users')
                      .get(req.body.id)
                      .update({recognition: r.row('recognition').add(ptsDiff)})
                      .run()
                      .then(function(result) {
                        if (result.replaced === 0) {
                          winston.error('Unable to adjust rally recognition reward', {user: req.body.id, endpoint: 'updateRally', type: errorHandler.NO_CHANGE});
                        }
                      })
                  })
              }
            }
          })
          .then(() => {
            return r.db('forum').table('content')
              .get(req.body.rallyId)
              .run()
              .then(function(rally) {
                if (!rally) {
                  return errorHandler.handleErrorMessage(res, 'Rally does not exist', errorHandler.BAD_REQUEST);
                } else if (rally.creator === req.body.id) {
                  updateObject.lastHeuristicUpdate = Date.now();
                  updateObject.heuristic = heuristicService.getHeuristic(rally);

                  if (!updateObject.privateLocation) {
                    return updateRallyData(req, res, rally, updateString, updateObject, updatingUser);
                  } else {
                    return r.db('util').table('regions')
                     .getNearest(updateObject.privateLocation, {index: 'location', maxDist: 75, unit: 'mi'})
                     .limit(1)
                     .coerceTo('array')
                     .run()
                     .then(region => {
                       updateObject.regionId = region.length > 0 ? region[0].doc.id : undefined;
                       return updateRallyData(req, res, rally, updateString, updateObject, updatingUser);
                     });
                  }
                } else {
                  return errorHandler.handleErrorMessage(res, 'User trying to update rally is not the creator', errorHandler.BAD_REQUEST);
                }
              })
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('updateRally')))
      .then(() => metric.logUserRequest(req.body.id, 'updateRally'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'updateRally', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Encountered error updating rally', errorHandler.EXCEPTION);
      });
  });
});

router.post('/deleteRally', function updateForumObj(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing host ID', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing rallyId', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('content')
      .get(req.body.rallyId)
      .run()
      .then(function(rally) {
        if (rally.creator === req.body.id) {
          return r.db('forum').table('content')
            .get(req.body.rallyId)
            .delete()
            .run()
            .then(function(result) {
              if (result.deleted.length === 0) {
                return errorHandler.handleErrorMessage(res, 'Unable to delete rally on database', errorHandler.NO_CHANGE);
              } else {
                var retObject = {message: 'Successfully deleted rally'};
                retObject.type = 'ok';
                retObject.eventId = result.generated_keys[0];
                res.status(200).send(JSON.stringify(retObject, null, 2));

                // Delete all of the related rally invites
                return r.db('forum').table('rallyInvites')
                  .getAll(req.body.rallyId, {index: 'rallyId'})
                  .delete()
                  .run()
                  .then(function(result) {
                    if (result.errors) {
                      winston.error('Errors deleting invites were found: ' + JSON.stringify(result),
                        {user: req.body.id, endpoint: 'deleteRally', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
                    }
                    return r.db('notification').table('events')
                      .getAll(req.body.rallyId, {index: 'item'})
                      .filter(function(note) {
                        return r.expr(['rallyInvite', 'rallyInviteAccepted', 'rallyRequest', 'rallyRequestAccepted',
                          'rallyAttendanceConfirmed', 'unconfirmRallyAttendance', 'leftRally', 'newRallyComment']).contains(note('type'));
                      })
                      .update({viewed: true})
                      .run()
                      .then(function() {
                        return r.db('user').table('recognitionHistory')
                          .getAll(req.body.rallyId, {index: 'typeId'})
                          .filter({type: 'You created a rally'})
                          .delete()
                          .run()
                          .then(function(resolution) {
                            if (resolution.deleted === 0) {
                              winston.error('Unable to delete rally recognition history',
                                {user: req.body.id, endpoint: 'deleteRally', trace: stackTrace.parse(err), type: errorHandler.NO_CHANGE});
                            }
                            return r.db('user').table('user')
                              .get(req.body.id)
                              .update({recogintion: r.row('recognition').add(rally.privacy === 'public' ? -15 : -5)})
                              .run()
                              .then(function(resolution) {
                                if (resolution.replaced === 0) {
                                  winston.error('Unable to update user recognition',
                                    {user: req.body.id, endpoint: 'deleteRally', trace: stackTrace.parse(err), type: errorHandler.NO_CHANGE});
                                }
                              })
                          })
                      })
                  });
              }
            });
        } else {
          return errorHandler.handleErrorMessage(res, 'User trying to delete the rally is not the host', errorHandler.BAD_REQUEST);
        }
      })
      .then(() => metric.checkTotal(() => metric.updateTable('totals', {totalRallies: -1})))
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deleteRally')))
      .then(() => metric.logUserRequest(req.body.id, 'deleteRally'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'deleteRally', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Encountered error updating rally', errorHandler.EXCEPTION);
      });
  });
});

router.post('/requestJoinRally', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user ID', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    }
    r.db('forum').table('content')
      .get(req.body.rallyId)
      .run()
      .then(rally => {
        return r.db('forum').table('rallyInvites')
          .getAll(req.body.id, {index: 'to'})
          .filter({rallyId: req.body.rallyId})
          .coerceTo('array')
          .run()
          .then(invites => {
            // currently handle this by lying to the user. Refactor later to update user that they've been invited
            if (invites.length > 0) {
              var retObject = {message: 'Successfully requested to join rally'};
              retObject.type = 'ok';
              res.status(200).send(JSON.stringify(retObject, null, 2));
            } else {
              rally.requestCount++;
              var heuristic = heuristicService.getHeuristic(rally);
              return r.db('forum').table('content')
                .get(req.body.rallyId)
                .update({
                  requests: r.row('requests').setInsert(req.body.id),
                  requestCount: r.row('requestCount').add(1), // TODO: fix this inflating the metric on rerequests
                  lastModified: Date.now(),
                  lastHeuristicUpdate: Date.now(),
                  heuristic: heuristic,
                }, {returnChanges: true})
                .run()
                .then(function(result) {
                  // I doubt this will ever get hit unless there is an error because we are updating UTC milli times
                  if (result.replaced === 0) {
                    return errorHandler.handleErrorMessage(req, 'Unable to join rally', errorHandler.NO_CHANGE);
                  }
                  var retObject = {message: 'Successfully requested to join rally'};
                  retObject.type = 'ok';
                  res.status(200).send(JSON.stringify(retObject, null, 2));

                  notify.createNotification(r, req.body.id, result.changes[0].new_val.creator, 'rallyRequest', req.body.rallyId);
                  // Remove any declined reference to the requesting user to keep from getting multiple entries in the database
                  if (result.changes[0].new_val.declined.indexOf(req.body.id) !== -1) {
                    return r.db('forum').table('content')
                      .get(req.body.rallyId)
                      .update({
                        declined: r.row('declined').deleteAt(result.changes[0].new_val.declined.indexOf(req.body.id))
                      })
                      .run();
                  }
                })
            }
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('requestJoinRally')))
      .then(() => metric.logUserRequest(req.body.id, 'requestJoinRally'))
      .catch(function(err) {
        winston.error(err, {user: req.body.ids, endpoint: 'requestJoinRally', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Encountered error inserting rally', errorHandler.EXCEPTION);
      });
  });
});

router.post('/acceptRequest', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.request) {
      return errorHandler.handleErrorMessage(res, 'Missing request id of requesting user', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .get(req.body.rallyId)
        .run()
        .then(function(result) {
          if (!result) {
            return errorHandler.handleErrorMessage(res, 'That rallyId does not map to any known rally', errorHandler.BAD_REQUEST);
          } else if (result.creator !== req.body.id) {
            return errorHandler.handleErrorMessage(res, 'User is not the host, only hosts can accept requests', errorHandler.BAD_REQUEST);
          } else if (result.requests.indexOf(req.body.request) === -1) {
            return errorHandler.handleErrorMessage(res, 'Rally does not have an open request for the given request id', errorHandler.BAD_REQUEST);
          } else {
            var heuristic = heuristicService.getHeuristic(result);
            return r.db('forum').table('content')
              .get(req.body.rallyId)
              .update({
                  requests: r.row('requests').deleteAt(result.requests.indexOf(req.body.request)),
                  members: r.row('members').append(req.body.request),
                  lastModified: Date.now(),
                  heuristic: heuristic,
                  lastHeuristicUpdate: Date.now()
                }, {returnChanges: true})
              .run()
              .then(function(rally) {
                if (rally.replaced !== 1) {
                  return errorHandler.handleErrorMessage(res, 'Unable to remove request and add members', errorHandler.NO_CHANGE);
                } else {
                  var retObject = {message: 'Successfully accepted rally request'};
                  retObject.type = 'ok';
                  res.status(200).send(JSON.stringify(retObject, null, 2));
                  notify.createNotification(r, rally.changes[0].new_val.creator, req.body.request, 'rallyRequestAccepted', req.body.rallyId);
                }
              });
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('acceptRequest')))
        .then(() => metric.logUserRequest(req.body.id, 'acceptRequest'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'acceptRequest', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to accept rally request', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/declineRequest', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.request) {
      return errorHandler.handleErrorMessage(res, 'Missing request id of requesting user', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .get(req.body.rallyId)
        .run()
        .then(function(result) {
          if (!result) {
            return errorHandler.handleErrorMessage(res, 'That rallyId does not map to any known rally', errorHandler.BAD_REQUEST);
          } else if (result.creator !== req.body.id) {
            return errorHandler.handleErrorMessage(res, 'User is not the host, only hosts can decline requests', errorHandler.BAD_REQUEST);
          } else if (result.requests.indexOf(req.body.request) === -1) {
            return errorHandler.handleErrorMessage(res, 'Rally does not have an open request for the given request id', errorHandler.BAD_REQUEST);
          } else {
            result.declinedCount++;
            var heuristic = heuristicService.getHeuristic(result);
            return r.db('forum').table('content')
              .get(req.body.rallyId)
              .update({
                  requests: r.row('requests').deleteAt(result.requests.indexOf(req.body.request)),
                  lastModified: Date.now(),
                  declinedCount: r.row('declinedCount').add(1),
                  heuristic: heuristic,
                  lastHeuristicUpdate: Date.now()
                }, {returnChanges: true})
              .run()
              .then(function(rally) {
                if (rally.replaced !== 1) {
                  return errorHandler.handleErrorMessage(res, 'Unable to remove request', errorHandler.NO_CHANGE);
                } else {
                  var retObject = {message: 'Successfully declined rally request'};
                  retObject.type = 'ok';
                  res.status(200).send(JSON.stringify(retObject, null, 2));
                }
              });
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('declineRequest')))
        .then(() => metric.logUserRequest(req.body.id, 'declineRequest'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'declineRequest', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to decline rally request', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/inviteToRally', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id'. errorHandler.BAD_INPUT);
    } else if (!req.body.userList) {
      return errorHandler.handleErrorMessage(res, 'Missing invited user list'. errorHandler.BAD_INPUT);
    } else if (!Array.isArray(req.body.userList)) {
      return errorHandler.handleErrorMessage(res, 'userList given is not an Array'. errorHandler.BAD_INPUT);
    } else if (req.body.userList.length === 0) {
      return errorHandler.handleErrorMessage(res, 'User List given is empty'. errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID'. errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .get(req.body.rallyId)
        .run()
        .then(function(result) {
          if (!result) {
            return errorHandler.handleErrorMessage('That rallyId does not map to any known rally', errorHandler.BAD_REQUEST);
          } else if (result.creator !== req.body.id) {
            return errorHandler.handleErrorMessage(res, 'User is not the host, only hosts can send invitations', errorHandler.BAD_REQUEST);
          } else if (result.endDate <= Date.now()) {
            return errorHandler.handleErrorMessage(res, 'This rally is over, create a new rally to invite more users', errorHandler.BAD_REQUEST);
          } else {
            var insertObject = [];
            // filter out users that are already in the rally to avoid possible race conditions
            req.body.userList = R.without(result.members, R.without(result.confirmedUsers, req.body.userList));
            req.body.userList.forEach(function(user) {
              insertObject.push({
                from: req.body.id,
                to: user,
                rallyId: req.body.rallyId,
                isPending: true
              })
            });
            // remove existing invites to the users first
            return r
              .db('forum').table('rallyInvites')
              .getAll(req.body.rallyId, {index: 'rallyId'})
              .filter(function(invite) {
                return r.expr(req.body.userList).contains(invite('to'));
              })
              .delete()
              .run()
              .then(function(resolution) {
                return r
                  .db('forum').table('rallyInvites')
                  .insert(insertObject)
                  .run()
                  .then(function(resolution) {
                    if (resolution.inserted < req.body.userList.length) {
                      return errorHandler.handleErrorMessage(res, 'Unable to invite all users: ' + resolution.inserted + '/' + req.body.userList.length, errorHandler.NO_CHANGE);
                    } else {
                      var retObject = {message: 'Successfully invited users to rally'};
                      retObject.type = 'ok';
                      res.status(200).send(JSON.stringify(retObject, null, 2));

                      req.body.userList.forEach(function(user) {
                        notify.createNotification(r, req.body.id, user, 'rallyInvite', req.body.rallyId);
                      })

                      var declinedWithoutInvites = R.without(req.body.userList, result.declined);
                      if (declinedWithoutInvites.length !== result.declined.length) {
                        return r.db('forum').table('content')
                          .get(req.body.rallyId)
                          .update({
                            declined: declinedWithoutInvites,
                            lastModified: Date.now()
                          })
                          .run()
                          .then(function(result) {
                            if (result.replaced === 0) {
                              winston.error('Unable to remove invited users from declined list',
                                {user: req.body.id, endpoint: 'inviteToRally', trace: stackTrace.parse(err), type: errorHandler.NO_CHANGE});
                            }
                          });
                      }
                    }
                  });
              });
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('inviteToRally')))
        .then(() => metric.logUserRequest(req.body.id, 'inviteToRally'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'inviteToRally', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to invite user to rally', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getRallyInvite', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    } else {
      return r.db('forum').table('rallyInvites')
        .getAll(req.body.rallyId, {index: 'rallyId'})
        .filter({to: req.body.id})
        .run()
        .then(function(result) {
            var retObject = {message: 'Successfully gathered rally invite'};
            retObject.type = 'ok';
            retObject.invite = result;
            res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getRallyInvite')))
        .then(() => metric.logUserRequest(req.body.id, 'getRallyInvite'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getRallyInvite', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying get rally invites', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getRallyInvites', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .get(req.body.rallyId)
        .run()
        .then(function(result) {
          if (!result) {
            return errorHandler.handleErrorMessage(res, 'That rallyId does not map to any known rally', errorHandler.BAD_REQUEST);
          } else {
            return r.db('forum').table('rallyInvites')
              .getAll(req.body.rallyId, {index: 'rallyId'})
              .filter({to: req.body.id, isPending: true})
              .isEmpty()
              .run()
              .then(function(isInvited) {
                if (result.confirmedUsers.indexOf(req.body.id) === -1 && result.members.indexOf(req.body.id) === -1 && isInvited) {
                  return errorHandler.handleErrorMessage(res, 'User is not a member of the rally', errorHandler.BAD_REQUEST);
                } else {
                  return r.db('forum').table('rallyInvites')
                    .getAll(req.body.rallyId, {index: 'rallyId'})
                    .filter({isPending: true})
                    .coerceTo('array')
                    .run()
                    .then(function(result) {
                      var retObject = {message: 'Successfully gathered rally invites'};
                      retObject.type = 'ok';
                      retObject.invites = result;
                      res.status(200).send(JSON.stringify(retObject, null, 2));
                    });
                }
              });
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getRallyInvites')))
        .then(() => metric.logUserRequest(req.body.id, 'getRallyInvites'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getRallyInvites', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying get rally invites', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getMyRallyInvites', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else {
      return r.db('user').table('users')
        .get(req.body.id)
        .getField('blockedUsers')
        .run()
        .then(function(blockedUsers) {
          return r.db('forum').table('rallyInvites')
            .getAll(req.body.id, {index: 'to'})
            .filter(function(invite) {
              return invite('isPending').eq(true).and(r.expr(blockedUsers).contains(invite('from')).not())
            })
            .map({
              'inviteId': r.row('id'),
              'from': r.row('from'),
              'rallyId': r.row('rallyId'),
              'isPending': r.row('isPending')
            })
            .eqJoin('rallyId', r.db('forum').table('content'))
            .without({
              right: ['to', 'rallyId', 'from'],
              left: ['address', 'declined', 'lastHeuristicUpdate', 'lastModified', 'requestCount', 'rallyId']
            })
            .zip()
            .coerceTo('array')
            .run()
        })
        .then(function(result) {
          var now = Date.now();
          result = result.map(rallyData => mapper.mapRallyData(rallyData, req.body.id));
          var removable = result.filter(function(invite) {
            return invite.endDate <= now;
          });
          if (removable.length > 0) {
            var returnable = result.filter(function(invite) {
              return invite.endDate > now;
            });
            var inviteIds = removable.map(function(invite) {
              return invite.inviteId;
            });
            var rallyIds = removable.map(function(invite) {
              return invite.id;
            });
            return r.db('forum').table('rallyInvites')
              .getAll(r.args(inviteIds))
              .update({isPending: false})
              .run()
              .then(function(resolution) {
                if (resolution.updated !== inviteIds.length) {
                  winston.error('Unable to remove expired rally invites', {user: req.body.id, endpoint: 'getMyRallyInvites', type: errorHandler.NO_CHANGE});
                }
                return r.db('notification').table('events')
                  .getAll(r.args(rallyIds), {index: 'item'})
                  .filter({user2: req.body.id, viewed: false, type: 'rallyInvite'})
                  .update({viewed: true})
                  .run()
                  .then(function(resolution) {
                    if (resolution.updated !== rallyIds.length) {
                      winston.error('Unable to remove expired rally invites', {user: req.body.id, endpoint: 'getMyRallyInvites', type: errorHandler.NO_CHANGE});
                    }
                    var retObject = {message: 'Successfully gathered my rally invites'};
                    retObject.type = 'ok';
                    retObject.invites = returnable;
                    retObject.updateNotifications = true;
                    res.status(200).send(JSON.stringify(retObject, null, 2));
                  });
              });
          } else {
            var retObject = {message: 'Successfully gathered my rally invites'};
            retObject.type = 'ok';
            retObject.invites = result;
            res.status(200).send(JSON.stringify(retObject, null, 2));
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getMyRallyInvites')))
        .then(() => metric.logUserRequest(req.body.id, 'getMyRallyInvites'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getMyRallyInvites', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying get rally invites', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/acceptInvite', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing rally id', errorHandler.BAD_INPUT);
    } else {
      // validate that the user has been invited to this event
      r.db('forum').table('rallyInvites')
        .getAll(req.body.id, {index: 'to'})
        .filter({isPending: true, rallyId: req.body.rallyId})
        .coerceTo('array')
        .run()
        .then(function(invite) {
          if (!invite || invite.length === 0) {
            return errorHandler.handleErrorMessage(res, 'There is no open invite for that rally', errorHandler.BAD_REQUEST);
          } else {
            return r.db('forum').table('rallyInvites')
              .getAll(req.body.id, {index: 'to'})
              .filter({isPending: true, rallyId: req.body.rallyId})
              .update({isPending: false})
              .run()
              .then(function(result) {
                if (result.replaced === 0) {
                  return errorHandler.handleErrorMessage(res, 'Unable to update any invite', errorHandler.NO_CHANGE);
                }
                return r.db('forum').table('content')
                  .get(req.body.rallyId)
                  .update({
                    confirmedUsers: r.row('confirmedUsers').setInsert(req.body.id),
                    lastModified: Date.now()
                  }, {returnChanges: true})
                  .run()
                  .then(function(result) {
                    if (result.replaced === 0) {
                      return errorHandler.handleErrorMessage(res, 'Unable to insert invite to user', errorHandler.NO_CHANGE);
                    }
                    var retObject = {message: 'Successfully accepted user invite to rally'};
                    retObject.type = 'ok';
                    res.status(200).send(JSON.stringify(retObject, null, 2));
                    notify.createNotification(r, req.body.id, result.changes[0].new_val.creator, 'rallyInviteAccepted', req.body.rallyId);
                    result.changes[0].old_val.confirmedUsers.forEach(function(user) {
                      if (user !== result.changes[0].old_val.creator) {
                        notify.createNotification(r, req.body.id, user, 'rallyAttendanceConfirmed', req.body.rallyId);
                      }
                    });
                    result.changes[0].old_val.members.forEach(function(user) {
                      if (user !== result.changes[0].old_val.creator) {
                        notify.createNotification(r, req.body.id, user, 'rallyAttendanceConfirmed', req.body.rallyId);
                      }
                    });
                  });
              });
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('acceptInvite')))
        .then(() => metric.logUserRequest(req.body.id, 'acceptInvite'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'acceptInvite', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to accept rally invite', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/declineInvite', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing rally id', errorHandler.BAD_INPUT);
    } else {
      // validate that the user has been invited to this event
      r.db('forum').table('rallyInvites')
        .getAll(req.body.id, {index: 'to'})
        .filter({isPending: true, rallyId: req.body.rallyId})
        .coerceTo('array')
        .run()
        .then(function(invite) {
          if (!invite || invite.length === 0) {
            return errorHandler.handleErrorMessage(res, 'There is no open invite for that rally', errorHandler.BAD_REQUEST);
          } else {
            return r.db('forum').table('rallyInvites')
              .getAll(req.body.id, {index: 'to'})
              .filter({isPending: true, rallyId: req.body.rallyId})
              .update({isPending: false, declined: true})
              .run()
              .then(function(result) {
                if (result.replaced === 0) {
                  return errorHandler.handleErrorMessage(res, 'Unable to update any invite', errorHandler.NO_CHANGE);
                }
                var retObject = {message: 'Successfully declined invite to rally'};
                retObject.type = 'ok';
                res.status(200).send(JSON.stringify(retObject, null, 2));
              });
          }
        })
        .then(function() {
          return r.db('forum').table('content')
            .get(req.body.rallyId)
            .run()
            .then(function(result) {
              if (!result) {
                winston.error("User declined an invite from a rally that no longer exists", {user: req.body.id, endpoint: 'declineInvite', type: errorHandler.BAD_REQUEST});
                return;
              } else if (result.declined.indexOf(req.body.id) !== -1) {
                // No reason to add twice. Return;
                return;
              } else {
                return r
                  .db('forum').table('content')
                  .get(req.body.rallyId)
                  .update({
                    confirmedUsers: r.row('confirmedUsers').filter(function(row) {
                      return row.eq(req.body.id).not();
                    }),
                    declined: r.row('declined').append(req.body.id),
                    lastModified: Date.now()
                  })
                  .run();
              }
            });
        })
        .then(function() {
          return r.db('notification').table('events')
            .getAll(req.body.id, {index: 'user2'})
            .filter(function(notification) {
              return notification('viewed').eq(false)
                .and(notification('item').eq(req.body.rallyId)
                  .and(notification('type').eq('rallyAttendanceConfirmed')
                    .or(notification('type').eq('unconfirmRallyAttendance'))
                    .or(notification('type').eq('leftRally'))
                    .or(notification('type').eq('rallyRequestAccepted'))
                    .or(notification('type').eq('newRallyComment'))))
            })
            .delete()
            .run();
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('declineInvite')))
        .then(() => metric.logUserRequest(req.body.id, 'declineInvite'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'declineInvite', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to accept rally invite', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/joinProtectedRally', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .get(req.body.rallyId)
        .run()
        .then(function(result) {
          if (!result) {
            return errorHandler.handleErrorMessage(res, 'That rallyId does not map to any known rally', errorHandler.BAD_REQUEST);
          } else if (result.privacy !== 'protected') {
            return errorHandler.handleErrorMessage(res, 'That rally is not a protected rally', errorHandler.BAD_REQUEST);
          } else {
            return r.db('user').table('users')
              .get(req.body.id)
              .run()
              .then(function(user) {
                if (!user) {
                  return errorHandler.handleErrorMessage(res, 'No user with that id in the database', errorHandler.BAD_REQUEST);
                } else if (!R.contains(result.creator, user.contacts)) {
                  return errorHandler.handleErrorMessage(res, 'User is not friends with the host of the protected rally', errorHandler.BAD_REQUEST);
                } else {
                  return r.db('forum').table('content')
                    .get(req.body.rallyId)
                    .update({
                        confirmedUsers: r.row('confirmedUsers').append(req.body.id),
                        lastModified: Date.now()
                      }, {returnChanges: true})
                    .run()
                    .then(function(result) {
                      if (result.replaced !== 1) {
                        return errorHandler.handleErrorMessage(res, 'Unable to join protected rally', errorHandler.NO_CHANGE);
                      } else {
                        var retObject = {message: 'Successfully joined the rally'};
                        retObject.type = 'ok';
                        res.status(200).send(JSON.stringify(retObject, null, 2));

                        result.changes[0].old_val.members.forEach(function(member) {
                          notify.createNotification(r, req.body.id, member, 'userJoined', req.body.rallyId);
                        });
                        result.changes[0].old_val.confirmedUsers.forEach(function(confirmedUser) {
                          notify.createNotification(r, req.body.id, confirmedUser, 'userJoined', req.body.rallyId);
                        });

                        // ensure outstanding rally invites are removed
                        return r.db('forum').table('rallyInvites')
                          .getAll(req.body.id, {index: 'to'})
                          .filter({rallyId: req.body.rallyId})
                          .update({isPending: false})
                          .run()
                          .then(updateResult => {
                            if (result.changes[0].new_val.declined.indexOf(req.body.id) !== -1) {
                              return r.db('forum').table('content')
                                .get(req.body.rallyId)
                                .update({
                                  declined: r.row('declined').deleteAt(result.changes[0].new_val.declined.indexOf(req.body.id))
                                })
                                .run();
                            }
                          });
                      }
                    });
                }
              });
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('joinProtectedRally')))
        .then(() => metric.logUserRequest(req.body.id, 'joinProtectedRally'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'joinProtectedRally', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to join protected rally', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/confirmRallyAttendance', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .get(req.body.rallyId)
        .run()
        .then(function(result) {
          if (!result) {
            return errorHandler.handleErrorMessage(res, 'That rallyId does not map to any known rally', errorHandler.BAD_REQUEST);
          } else if (result.members.indexOf(req.body.id) === -1) {
            return errorHandler.handleErrorMessage(res, 'User is not a member of the rally and cannot confirm attendance', errorHandler.BAD_REQUEST);
          } else {
            return r.db('forum').table('content')
              .get(req.body.rallyId)
              .update({
                  members: r.row('members').deleteAt(result.members.indexOf(req.body.id)),
                  confirmedUsers: r.row('confirmedUsers').append(req.body.id),
                  lastModified: Date.now()
                }, {returnChanges: true})
              .run()
              .then(function(result) {
                if (result.replaced !== 1) {
                  return errorHandler.handleErrorMessage(res, 'Unable to remove member and add confirmed user', errorHandler.NO_CHANGE);
                } else {
                  var retObject = {message: 'Successfully confirmed rally attendance'};
                  retObject.type = 'ok';
                  res.status(200).send(JSON.stringify(retObject, null, 2));

                  result.changes[0].old_val.confirmedUsers.forEach(function(user) {
                    notify.createNotification(r, req.body.id, user, 'rallyAttendanceConfirmed', req.body.rallyId);
                  });
                  result.changes[0].new_val.members.forEach(function(user) {
                    notify.createNotification(r, req.body.id, user, 'rallyAttendanceConfirmed', req.body.rallyId);
                  });
                }
              });
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('confirmRallyAttendance')))
        .then(() => metric.logUserRequest(req.body.id, 'confirmRallyAttendance'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'confirmRallyAttendance', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to confirm rally attendance', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/unconfirmRallyAttendance', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .get(req.body.rallyId)
        .run()
        .then(function(result) {
          if (!result) {
            return errorHandler.handleErrorMessage(res, 'That rallyId does not map to any known rally', errorHandler.BAD_REQUEST);
          } else if (result.confirmedUsers.indexOf(req.body.id) === -1) {
            return errorHandler.handleErrorMessage(res, 'User has not confirmed attendance and cannot unconfirm', errorHandler.BAD_REQUEST);
          } else {
            return r.db('forum').table('content')
              .get(req.body.rallyId)
              .update({
                  confirmedUsers: r.row('confirmedUsers').deleteAt(result.confirmedUsers.indexOf(req.body.id)),
                  members: r.row('members').append(req.body.id),
                  lastModified: Date.now()
                }, {returnChanges: true})
              .run()
              .then(function(result) {
                if (result.replaced !== 1) {
                  return errorHandler.handleErrorMessage(res, 'Unable to remove confirmed user and add member', errorHandler.NO_CHANGE);
                } else {
                  var retObject = {message: 'Successfully unconfirmed attendance to rally'};
                  retObject.type = 'ok';
                  res.status(200).send(JSON.stringify(retObject, null, 2));

                  result.changes[0].new_val.confirmedUsers.forEach(function(user) {
                    notify.createNotification(r, req.body.id, user, 'unconfirmRallyAttendance', req.body.rallyId);
                  });
                  result.changes[0].old_val.members.forEach(function(user) {
                    notify.createNotification(r, req.body.id, user, 'unconfirmRallyAttendance', req.body.rallyId);
                  });
                }
              });
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('unconfirmRallyAttendance')))
        .then(() => metric.logUserRequest(req.body.id, 'unconfirmRallyAttendance'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'unconfirmRallyAttendance', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to unconfirm rally attendance', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/leaveRally', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.rallyId) {
      return errorHandler.handleErrorMessage(res, 'Missing the rally ID', errorHandler.BAD_INPUT);
    } else {
      r.db('forum').table('content')
        .get(req.body.rallyId)
        .run()
        .then(function(result) {
          if (!result) {
            return errorHandler.handleErrorMessage(res, 'That rallyId does not map to any known rally', errorHandler.BAD_REQUEST);
          } else if (result.confirmedUsers.indexOf(req.body.id) === -1 && result.members.indexOf(req.body.id) === -1) {
            return errorHandler.handleErrorMessage(res, 'User is not a member of the rally', errorHandler.BAD_REQUEST);
          } else
            // remove user from members list
            return r.db('forum').table('content')
              .get(req.body.rallyId)
              .update(r.branch(r.expr(result.confirmedUsers.indexOf(req.body.id)).eq(-1),
                  {
                    members: r.row('members').deleteAt(result.members.indexOf(req.body.id)),
                    declined: r.row('declined').append(req.body.id),
                    lastModified: Date.now()
                  },
                  {
                    confirmedUsers: r.row('confirmedUsers').deleteAt(result.confirmedUsers.indexOf(req.body.id)),
                    declined: r.row('declined').append(req.body.id),
                    lastModified: Date.now()
                  }),
                {returnChanges: true})
              .run()
              .then(function(resolution) {
                if (resolution.replaced !== 1) {
                  return errorHandler.handleErrorMessage(res, 'Unable to remove confirmed user and add member');
                }
                var retObject = {message: 'Successfully left the rally'};
                retObject.type = 'ok';
                res.status(200).send(JSON.stringify(retObject, null, 2));

                // notify other members and confirmed users
                // result.changes[0].new_val.members.forEach(function(user) {
                //   notify.createNotification(r, req.body.id, user, 'leftRally', req.body.rallyId);
                // });
                resolution.changes[0].new_val.confirmedUsers.forEach(function(user) {
                  notify.createNotification(r, req.body.id, user, 'leftRally', req.body.rallyId);
                });

                if (result.declined.indexOf(req.body.id) !== -1) {
                  winston.info("User leaving the rally has already left before", {user: req.body.id, endpoint: 'leaveRally'});
                  return r.db('forum').table('content')
                    .get(req.body.rallyId)
                    .update({
                      declined: r.row('declined').deleteAt(result.declined.indexOf(req.body.id)),
                      lastModified: Date.now()
                    }, {returnChanges: true})
                    .run()
                    .then(function(result) {
                      if (result.replaced !== 1) {
                        winston.error("Unable to remove duplicate declined entries in rally", {user: req.body.id, endpoint: 'leaveRally', type: errorHandler.NO_CHANGE});
                      }
                      if (result.changes[0].new_val.declined.indexOf(req.body.id) !== -1) {
                        winston.error("Unable to remove duplicate declined entry index in rally", {user: req.body.id, endpoint: 'leaveRally', type: errorHandler.NO_CHANGE});
                      }
                    })
                }
              });
          })
          .then(function() {
            return r.db('notification').table('events')
              .getAll(req.body.id, {index: 'user2'})
              .filter(function(notification) {
                return notification('viewed').eq(false)
                  .and(notification('item').eq(req.body.rallyId)
                    .and(notification('type').eq('rallyAttendanceConfirmed')
                      .or(notification('type').eq('unconfirmRallyAttendance'))
                      .or(notification('type').eq('leftRally'))
                      .or(notification('type').eq('rallyRequestAccepted'))
                      .or(notification('type').eq('newRallyComment'))))
              })
              .delete()
              .run();
              // Don't have anything to do with the result
          })
          .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
          .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('leaveRally')))
          .then(() => metric.logUserRequest(req.body.id, 'leaveRally'))
          .catch(function(err) {
            winston.error(err, {user: req.body.id, endpoint: 'leaveRally', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
            errorHandler.handleErrorMessage(res, 'Encountered error trying to leave rally', errorHandler.EXCEPTION);
          });
    }
  });
});

router.post('/getMyUpcomingRallies', function(req, res) {
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
      .then(contacts => {
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
                return doc('confirmedUsers').setUnion(doc('members')).contains(req.body.id)
                  .or(r.expr(rallyIds).contains(doc('id')))
                  .and(doc('endDate').gt(Date.now()))
              })
              .without('address', 'declined', 'lastHeuristicUpdate', 'lastModified', 'requestCount')
              .coerceTo('array')
              .run()
              .then(function(result) {
                var retObject = { message: 'Successfully gathered my rallies' };
                retObject.type = 'ok';
                retObject.rallies = result.map(rallyData => {
                  rallyData.isPending = rallyIds.indexOf(rallyData.id) !== -1;
                  return mapper.mapRallyData(rallyData, req.body.id, contacts)
                });
                res.status(200).send(JSON.stringify(retObject, null, 2));
              })
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getMyUpcomingRallies')))
      .then(() => metric.logUserRequest(req.body.id, 'getMyUpcomingRallies'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getMyUpcomingRallies', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Encountered error trying to get upcoming rallies', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getMyPendingRallies', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    }
    var now = Date.now();

    r.db('user').table('users')
      .get(req.body.id)
      .getField('contacts')
      .run()
      .then(contacts => {
        return r.db('forum').table('content')
          .getAll('rally', {index: 'type'})
          .filter(function(post) {
            return post('requests').contains(req.body.id).and(post('startDate').gt(now))
          })
          .without('address', 'declined', 'lastHeuristicUpdate', 'lastModified', 'requestCount')
          .coerceTo('array')
          .run()
          .then(function(result) {
            var retObject = { message: 'Successfully gathered my rallies' };
            retObject.type = 'ok';
            retObject.rallies = result.map(rallyData => mapper.mapRallyData(rallyData, req.body.id, contacts));
            res.status(200).send(JSON.stringify(retObject, null, 2));
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getMyPendingRallies')))
      .then(() => metric.logUserRequest(req.body.id, 'getMyPendingRallies'))
      .catch(function(err) {
        winston.error(err, {user: req.body.id, endpoint: 'getMyPendingRallies', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Encountered error trying to get pending rallies', errorHandler.EXCEPTION);
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
