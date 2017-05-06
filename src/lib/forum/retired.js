// Attempts at setting up the forum "hot" system with ReQL


// function getMemberCategories(regions, callback) {
//   r.db('forum').table('membership')
//     .getAll(req.body.id, {index: 'userId'})
//     .eqJoin('forumId', r.db('forum').table('forums'))('right')('category')
//     .distinct()
//     .coerceTo('array')
//     .run()
//     .then(function(result) {
//       // push general if the user doesn't use anything else
//       if (result.length === 0) {
//         result.push('general');
//       }
//       callback(null, result, regions);
//     })
//     .catch(function(err) {
//       winston.error(err, {user: req.body.id, endpoint: 'getPersonalizedContent', trace: stackTrace.parse(err)});
//       handleErrorMessage(res, 'Serious server issue');
//     })
// },

// function addHeuristics(result, callback) {
//   var todayDays = new Date().getTime() / 86400000;
//   r.db('forum').table('contentMap')
//     .getAll("f53e9d6e-6206-4274-b45a-1206faad9fb2", {index: 'forumId'})
//     .eqJoin('contentId', r.db('forum').table('content'))
//     .pluck('right', {left: 'forumId'})
//     .zip()
//     .filter(function(doc) {
//       return r.expr(["5591778","5601933","5586437","5587698","5600685","5597955"])
//         .contains(doc('cityId'));
//     })
//     .orderBy(r.desc(function(row) {
//       return r.branch(row('cityId').eq('5586437'), 1.2, 1)
//         .mul(row('votes').add(row('comments')))
//         .div(row('tsCreated').div(-86400000).add(todayDays).add(2));
//     }))
// },


// Slower JS based function:
// r.db('forum').table('contentMap')
//   .getAll("f53e9d6e-6206-4274-b45a-1206faad9fb2", {index: 'forumId'})
//   .eqJoin('contentId', r.db('forum').table('content'))
//   .pluck('right', {left: 'forumId'})
//   .zip()
//   .merge({
//     now: new Date().getTime() / 86400000,
//     created: r.row('tsCreated').div(86400000).round()
//   })
//   .filter(function(doc) {
//     return r.expr(["5591778","5601933","5586437","5587698","5600685","5597955"])
//       .contains(doc('cityId'));
//   })
//   .orderBy(
//     r.desc(
//       r.js('(function (row) {
//         if (row.type === "post") {
//       		return ((row.cityId === "5586437") ? 1.2 : 1) * (row.votes + Math.pow(row.comments, 1.2)) /
//     				(Math.pow(row.created + row.now + 2, 1.5))
// } else {
//   return ((row.cityId === "5586437") ? 1.2 : 1) * (row.votes + Math.pow(row.comments, 1.2)) *
//     Math.max(Math.abs(7), 0.7);
// }
//       })')
//   ))


// DEPRECATED - no longer in use 4/21/2016
router.post('/createForum', function(req, res) {
  async.waterfall([
    function checkAuthentication(callback) {
      auth.checkAuthAndId(req, res, req.body.id, callback);
    },
    function checkRequest(callback) {
      if (!req.body.id) {
        return callback('No userId given');
      }
      if (!req.body.title) {
        return callback('No title given');
      }
      if (!req.body.description) {
        return callback('No description given');
      }
      if (!req.body.cityId) {
        return callback('No chosen city');
      }
      if (!req.body.category) {
        return callback('No category given');
      }
      if (!req.body.isPrivate) {
        req.body.isPrivate = false;
      }
      callback();
    },
    function insertForum(callback) {
      r.db('forum').table('forums').insert({
        title: req.body.title,
        description: req.body.description,
        tsCreated: new Date().getTime(),
        owner: req.body.id,
        category: req.body.category,
        isPrivate: req.body.isPrivate
      }).run().then(function afterPostInsertion(res) {
        if (res.generated_keys.length !== 0) {
          callback(null, res);
          return;
        } else {
          winston.error('ERROR: could not create forum. Result: ' + JSON.stringify(res),
            {user: req.body.id, endpoint: 'createForum'});
          return callback('Server error creating forum');
        }
      })
      .catch(function creationError(err) {
        winston.error(err, {user: req.body.id, endpoint: 'createForum', trace: stackTrace.parse(err)});
        return callback('Issue inserting forum');
      });
    },
    // TODO: get rid of this!
    function insertMappings(result, callback) {
      if (!req.body.isPrivate) {
        createCityMapping(result.generated_keys[0], req.body.cityId)
        return callback(null, result);
      } else {
        // Gets all matching regions for a city
        r.db('util').table('regions')
          .getAll(req.body.cityId, {index: 'cityId'})
          .innerJoin(r.db('util').table('regions'), function joinRegion(region, regionData) {
            return region('regionName').eq(regionData('regionName'))
          })
          .without('left')('right')
          .getField('cityId')
          .coerceTo('array')
          .run()
          .then(function resolveCities(cities) {
            if (cities.length === 0) {
              winston.warn('Couldn\'t find region to categorize city: ' + req.body.cityId)
              createCityMapping(result.generated_keys[0], req.boy.cityId)
              return callback(null, result);
            } else {
              for(var i in cities) {
                createCityMapping(result.generated_keys[0], cities[i]);
              }
              return callback(null, result);
            }
          })
          .catch(function(err) {
            winston.error('ERROR: could not insert forum mapping: ' + JSON.stringify(res),
              {user: req.body.id, endpoint: 'createForum', trace: stackTrace.parse(err)});
          });
      }
    },
    // TODO: make sure the forum doesn't need anything special
    function insertPermissions(result, callback) {
      r.db('user').table('permissions')
        .insert({
          type: 'forum',
          userId: req.body.id,
          typeId: result.generated_keys[0],
          permissionName: 'edit'
        })
        .run()
        .then(function(res) {
          if (res.generated_keys.length !== 0) {
            return callback(null, result);
          } else {
            winston.error('ERROR: could create forum. Result: ' + JSON.stringify(res),
              {user: req.body.id, endpoint: 'createForum'});
            return callback('Server error creating forum');
          }
        })
        .catch(function catchErr(err) {
          winston.error(err, {user: req.body.id, endpoint: 'createForum', trace: stackTrace.parse(err)});
          return callback('Could not insert content permissions');
        });
    },
    function allGood(result, callback) {
      var retObject = {message: 'Successfully created forum'};
      retObject.type = 'ok';
      retObject.forumId = result.generated_keys[0];
      res.status(200).send(JSON.stringify(retObject, null, 2));
      callback();
    },
    function checkTotalMetric(callback) {
      metric.checkTotal(callback);
    },
    function addUserTotal(callback) {
      metric.updateTable('totals', {totalPosts: 1}, callback);
    },
    function checkDailyMetric(callback) {
      metric.checkDaily(callback);
    },
    function addDailyMetric(callback) {
      var values = {requests: 1};
      metric.updateTable('dailyMetrics', values, callback);
    },
    function checkRequestedEndpoints(callback) {
      metric.checkRequestedEndpoints(callback);
    },
    function markEndpoint(callback) {
      metric.markEndpointRequested('createForum', callback);
    },
  ], function(err) {
    if (err) {
      handleErrorMessage(res, err);
    }
  });
});
//
// /createForum:
//   post:
//     summary: Create a new forum
//     description: |
//       Create a new forum and assign permissions to user.
//       Permissions should be updated after posting.
//       Lat and lng are not required and will default to Boise.
//     parameters:
//       - name: id
//         in: query
//         description: userId
//         required: true
//         type: string
//         format: string
//       - name: title
//         in: query
//         description: title of post
//         required: true
//         type: string
//         format: string
//       - name: description
//         in: query
//         description: details of post
//         required: true
//         type: string
//         format: string
//       - name: cityId
//         in: query
//         description: id of city
//         required: true
//         type: string
//         format: string
//       - name: category
//         in: query
//         description: category of forum
//         required: true
//         type: string
//         format: string
//       - name: isPrivate
//         in: query
//         description: determines if forum is restricted to city
//         required: true
//         type: boolean
//     tags:
//       - Forum
//     responses:
//       200:
//         description: Resulting object containing the forums
//         schema:
//           $ref: '#/definitions/ForumCreated'
//       500:
//         description: Unexpected error
//         schema:
//           $ref: '#/definitions/Error'


function createCityMapping(forumId, cityId) {
  r.db('forum').table('forumToCityMaps')
    .insert({
      forumId: forumId,
      cityId: cityId,
      tsCreated: Date.now()
    })
    .run()
    .catch(function(err) {
      winston.error(err, {user: req.body.id, endpoint: 'func_createCityMapping', trace: stackTrace.parse(err)});
    });
}



// Returns a list of all forums that have a given forum as their parent
router.post('/getForumContent', function(req, res) {
  var dateToday = Date.now() / 86400000;
  async.waterfall([
    function checkAuthentication(callback) {
      auth.checkAuthAndId(req, res, req.body.id, callback);
    },
    function checkRequest(callback) {
      if (!req.body.id) {
        return callback('No userId given');
      }
      if (!req.body.forumId) {
        return callback('No parent forum id given');
      }
      if (!req.body.cityId) {
        return callback('No cityId given');
      }
      callback();
    },
    function getRegionCount(callback) {
      r.db('util').table('regions')
        .getAll(req.body.cityId, {index: 'cityId'})
        .innerJoin(r.db('util').table('regions'), function(city, region) {
          return city('regionName').eq(region('regionName'));
        })('right')('cityId')
        .coerceTo('array')
        .run()
        .then(function(regions) {
          return callback(null, regions);
        })
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getForumContent', trace: stackTrace.parse(err)});
          handleErrorMessage(res, 'Serious server issue');
        });
    },
    // Get regional forum content based on city checking for region
    function getForumInformation(regions, callback) {
      var todayDate = Date.now();
      if (regions.length > 0) {
        r.db('forum').table('contentMap')
          .getAll(req.body.forumId, {index: 'forumId'})
          .eqJoin('contentId', r.db('forum').table('content'))
          .pluck('right', {left: 'forumId'})
          .zip()
          .filter(function(doc) {
            return r.expr(regions).contains(doc('cityId'));
          })
          .filter(function(doc) {
            return r.branch(doc('type').eq('event'),
              doc('endDate').gt(todayDate),
              true)
          })
          .pluck('cityId', 'comments', 'costs', 'creator', 'creatorName', 'creatorImage', 'creatorFirstName', 'endDate', 'id', 'links', 'photo', 'startDate', 'title', 'tsCreated', 'type', 'votes', 'url')
          .coerceTo('array')
          .run()
          .then(function(result) {
            callback(null, result);
          })
          .catch(function(err) {
            winston.error(err, {user: req.body.id, endpoint: 'getForumContent', trace: stackTrace.parse(err)});
            handleErrorMessage(res, 'Serious server issue');
          });
      } else {
        winston.info('No region for cityId ' + req.body.cityId, {user: req.body.id, endpoint: 'getForumContent'});
        r.db('forum').table('contentMap')
          .getAll(req.body.forumId, {index: 'forumId'})
          .eqJoin('contentId', r.db('forum').table('content'))
          .pluck('right', {left: 'forumId'})
          .zip()
          .filter({cityId: req.body.cityId})
          .filter(function(doc) {
            return r.branch(doc('type').eq('event'),
              doc('endDate').gt(todayDate),
              true)
          })
          .pluck('cityId', 'comments', 'costs', 'creator', 'creatorName', 'creatorImage', 'creatorFirstName', 'endDate', 'id', 'links', 'photo', 'startDate', 'title', 'tsCreated', 'type', 'votes', 'url')
          .coerceTo('array')
          .run()
          .then(function(result) {
            callback(null, result);
          })
          .catch(function(err) {
            winston.error(err, {user: req.body.id, endpoint: 'getForumContent', trace: stackTrace.parse(err)});
            handleErrorMessage(res, 'Serious server issue');
          });
      }
    },
    function addHeuristics(result, callback) {
      async.each(result, function(row, finish) {
        var hoursSincePosted = dateToday - row.tsCreated / 86400000;
        if (row.type === 'post') {
          // d(p + c^1.2)/(t+2)^1.5
          row.heuristic = ((row.cityId === req.body.cityId) ? 1.2 : 1) *
            (row.votes + Math.pow(row.comments, 1.2)) /
            (Math.pow(hoursSincePosted + 2, 1.5));
          finish();
        } else if (row.type === 'event') {
          var hoursTillEvent = row.endDate / 86400000 - dateToday;
          var hoursWait = row.endDate / 86400000 - row.tsCreated / 86400000;
          var hoursTillStart = row.startDate / 86400000 - dateToday;
          var mult = 0.0;
          if (Math.abs(hoursTillStart) < 1) {
            mult = 1.1;
          }
          row.heuristic = ((row.cityId === req.body.cityId) ? 1.2 : 1) *
            (row.votes + Math.pow(row.comments, 1.2)) *
            (Math.max(Math.abs(hoursSincePosted - hoursTillEvent) / (hoursWait/1.2), 0.7, mult));
          finish();
        } else {
          row.heuristic = ((row.cityId === req.body.cityId) ? 1.2 : 1) *
            (row.votes + Math.pow(row.comments, 1.2)) /
            (Math.pow(hoursSincePosted + 2, 1.5));
          finish();
        }
      }, function(err) {
        if (err) {
          winston.error(err, {user: req.body.id, endpoint: 'getForumContent', trace: stackTrace.parse(err)});
          handleErrorMessage(res, 'Serious server issue');
        } else {
          callback(null, result);
        }
      })
    },
    function sortByHeuristic(result, callback) {
      async.sortBy(result, function(row, finish) {
        finish(null, (row.heuristic * -1));
      }, function(err, results) {
        if (err) {
          winston.error(err, {user: req.body.id, endpoint: 'getForumContent', trace: stackTrace.parse(err)});
          handleErrorMessage(res, 'Serious server issue');
        } else {
          callback(null, results);
        }
      })
    },
    function allGood(result, callback) {
      var retObject = {message: 'Successfully gathered child forum data'};
      retObject.type = 'ok';
      retObject.forums = result;
      // TODO: update this to retObject
      res.status(200).send(JSON.stringify(result, null, 2));
      callback();
    },
    function checkDailyMetric(callback) {
      metric.checkDaily(callback);
    },
    function addDailyMetric(callback) {
      var values = {requests: 1};
      metric.updateTable('dailyMetrics', values, callback);
    },
    function checkRequestedEndpoints(callback) {
      metric.checkRequestedEndpoints(callback);
    },
    function markEndpoint(callback) {
      metric.markEndpointRequested('getForumContent', callback);
    },
    function logUserRequestEndpoint(callback) {
      return metric.logUserRequest(req.body.id, 'getForumContent', callback);
    },
  ], function(err) {
    if (err) {
      handleErrorMessage(res, err, 'getForumContent');
    }
  });
});


function calculateAndAppendHeuristics(req, result, callback) {
  var dateToday = Date.now() / ONE_DAY;
  async.each(result, function(row, finish) {
    var hoursSincePosted = dateToday - row.tsCreated / ONE_DAY;
    if (row.type === 'post') {
      // d(p + c^1.2)/(t+2)^1.5
      row.heuristic = ((row.cityId === req.body.cityId) ? 1.2 : 1) *
        (row.votes + Math.pow(row.comments, 1.2)) /
        (Math.pow(hoursSincePosted + 2, 1.1));
      finish();
    } else if (row.type === 'event') {
      var hoursTillEvent = row.endDate / ONE_DAY - dateToday;
      var hoursWait = row.endDate / ONE_DAY - row.tsCreated / ONE_DAY;
      var hoursTillStart = row.startDate / ONE_DAY - dateToday;
      var mult = 0.0;
      // if within an hour of the start time
      if (Math.abs(hoursTillStart) < 1) {
        mult = 1.5;
      }
      row.heuristic = ((row.cityId === req.body.cityId) ? 1.2 : 1) *
        (row.votes + Math.pow(row.comments, 1.2)) *
        (Math.max(Math.abs(hoursSincePosted - hoursTillEvent) / (hoursWait/1.2), 0.7, mult));
      finish();
    } else {
      // d(p + c^1.2)/(t+2)^1.5
      row.heuristic = ((row.cityId === req.body.cityId) ? 1.2 : 1) *
        (row.votes + Math.pow(row.comments, 1.2)) /
        (Math.pow(hoursSincePosted + 2, 1.1));
      finish();
    }
  }, function(err) {
    if (err) {
      callback(err, result);
    } else {
      callback(null, result);
    }
  })
}

function sortByHeuristic(result, callback) {
  async.sortBy(result, function(row, finish) {
    finish(null, (row.heuristic * -1));
  }, function(err, results) {
    if (err) {
      callback(err, results);
    } else {
      callback(null, results);
    }
  })
}



/// OLD TO HANDLE MULTIPLE WAYS TO GET content
// Returns a list of all content with a given category
router.post('/getPersonalizedContent', function(req, res) {
  var dateToday = Date.now() / 86400000;
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'No userId given', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'No cityId given', errorHandler.NO_LOCATION);
    } else {
      if (!req.body.page) {
        req.body.page = 0;
      }
      r.db('util').table('regions')
        .getAll(req.body.cityId, {index: 'cityId'})
        .innerJoin(r.db('util').table('regions'), function(city, region) {
          return city('regionName').eq(region('regionName'));
        })('right')('cityId')
        .coerceTo('array')
        .run()
        .then(function(regions) {
          var todayDate = Date.now();
          if (regions.length > 0) {
            return r.db('user').table('users')
              .get(req.body.id)
              .run()
              .then(function(userData) {
                return r.db('forum').table('content')
                  .orderBy({index:r.desc('heuristic')})
                  .filter(function(doc) {
                    return r.expr(regions).contains(doc('cityId'))
                      .and(r.expr(userData.blockedUsers).contains(doc('creator')).not())
                      .and(r.expr(userData.blockedBy).contains(doc('creator')).not());
                  })
                  .filter(function(doc) {
                    return r.branch(doc('type').eq('event').or(doc('type').eq('rally')),
                      doc('endDate').gt(todayDate).and(
                        r.branch(doc('type').eq('rally'),
                          doc('privacy').eq('public'),
                          true)
                      ),
                      true);
                  })
                  .map(function(doc) {
                    return doc.merge({'voted': doc('voteList').contains(req.body.id)})
                  })
                  .skip(req.body.page * 100)
                  .limit(100)
                  .coerceTo('array')
                  .run()
                  .then(function(result) {
                    heuristicService.applyLocation(result, req.body.cityId, finalResult => {
                      var retObject = {message: 'Successfully gathered personalized content'};
                      retObject.type = 'ok';
                      retObject.forums = finalResult;
                      res.status(200).send(JSON.stringify(retObject, null, 2));
                    });
                  })
              })
          } else if (req.body.cityId === -1) {
            return r.db('user').table('users')
              .get(req.body.id)
              .run()
              .then(function(userData) {
                return r.db('forum').table('content')
                  .orderBy({index:r.desc('heuristic')})
                  .filter(function(doc) {
                    return r.expr(userData.blockedUsers).contains(doc('creator')).not()
                      .and(r.expr(userData.blockedBy).contains(doc('creator')).not());
                  })
                  .filter(function(doc) {
                    return r.branch(doc('type').eq('event').or(doc('type').eq('rally')),
                      doc('endDate').gt(todayDate).and(
                        r.branch(doc('type').eq('rally'),
                          doc('privacy').eq('public'),
                          true)
                      ),
                      true);
                  })
                  .map(function(doc) {
                    return doc.merge({'voted': doc('voteList').contains(req.body.id)})
                  })
                  .skip(req.body.page * 100)
                  .limit(100)
                  .coerceTo('array')
                  .run()
                  .then(function(result) {
                    retObject.type = 'ok';
                    retObject.forums = result;
                    res.status(200).send(JSON.stringify(retObject, null, 2));
                  })
              })
          } else {
            // Out of region requesting content for a specific city is weird
            winston.info('Non-regional content request for cityId ' + req.body.cityId, {user: req.body.id, endpoint: 'getPersonalizedContent'});
            return r.db('user').table('users')
              .get(req.body.id)
              .run()
              .then(function(userData) {
                return r.db('forum').table('content')
                  .orderBy({index:r.desc('heuristic')})
                  .filter(function(doc) {
                    return doc('cityId').eq(req.body.cityId)
                      .and(r.expr(userData.blockedUsers).contains(doc('creator')).not())
                      .and(r.expr(userData.blockedBy).contains(doc('creator')).not());
                  })
                  .filter(function(doc) {
                    return r.branch(doc('type').eq('event').or(doc('type').eq('rally')),
                      doc('endDate').gt(todayDate).and(
                        r.branch(doc('type').eq('rally'),
                          doc('privacy').eq('public'),
                          true)
                      ),
                      true);
                  })
                  .map(function(doc) {
                    return doc.merge({'voted': doc('voteList').contains(req.body.id)})
                  })
                  .skip(req.body.page * 100)
                  .limit(100)
                  .coerceTo('array')
                  .run()
                  .then(function(result) {
                    calculateAndAppendHeuristics(req, result, (err, result2) => {
                      if (err) {
                        winston.error(err, {user: req.body.id, endpoint: 'getPersonalizedContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
                        return errorHandler.handleErrorMessage(res, 'Problem calculating heuristics on result set', errorHandler.EXCEPTION)
                      }
                      sortByHeuristic(result, (err, finalResult) => {
                        if (err) {
                          winston.error(err, {user: req.body.id, endpoint: 'getPersonalizedContent', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
                          return errorHandler.handleErrorMessage(res, 'Problem calculating heuristics on result set', errorHandler.EXCEPTION)
                        }
                        var retObject = {message: 'Successfully gathered personalized content'};
                        retObject.type = 'ok';
                        retObject.forums = result;
                        res.status(200).send(JSON.stringify(retObject, null, 2));
                      })
                    })
                  })
              })
          }
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


router.post('/createQuestion', function(req, res) {
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
      return errorHandler.handleErrorMessage(res, 'User is not within a region and cannot post', errorHandler.BAD_REQUEST);
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
            creatorImage: userData.imageUrl,
            comments: 0,
            votes: 0,
            voteList: [],
            category: req.body.category,
            cityId: req.body.cityId,
            startDate: 0,  //Why is this here?
            heuristic: 0,
            lastHeuristicUpdate: Date.now(),
            question: true
          })
          .run()
          .then(function afterPostInsertion(result) {
            if (result.generated_keys.length !== 0) {
              var retObject = {message: 'Successfully created question'};
              retObject.type = 'ok';
              retObject.postId = result.generated_keys[0];
              if (req.body.photo) {
                s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: result.generated_keys[0] + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, url) {
                  if (err) {
                    winston.error(err, {user: req.body.id, endpoint: 'createQuestion', type: errorHandler.NO_CHANGE});
                    return errorHandler.handleErrorMessage(res, 'Able to create question but not get photo upload urls', errorHandler.NO_CHANGE);
                  }
                  retObject.fullPhotoUrl = url;
                  s3.getSignedUrl('putObject', {ACL: 'public-read', Bucket: config.awsBucket, Key: 'thumb_' + result.generated_keys[0] + '.jpg', ContentType: 'image/jpeg', StorageClass: 'STANDARD'}, function(err, smallUrl) {
                    if (err) {
                      winston.error(err, {user: req.body.id, endpoint: 'createQuestion', type: errorHandler.NO_CHANGE});
                      return errorHandler.handleErrorMessage(res, 'Able to create question but not get photo upload urls', errorHandler.NO_CHANGE);
                    }
                    retObject.thumbnailUrl = smallUrl;
                    res.status(200).send(JSON.stringify(retObject, null, 2));
                    metric.checkTotal(function() {
                      metric.updateTable('totals', {totalQuestions: 1});
                    });
                    return updateRecognitionValues();
                  });
                });
              } else {
                res.status(200).send(JSON.stringify(retObject, null, 2));
                metric.checkTotal(function() {
                  metric.updateTable('totals', {totalQuestions: 1});
                });
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
              winston.error('ERROR: could not create question. Result: ' + JSON.stringify(res),
                {user: req.body.id, endpoint: 'createQuestion', reqBody: req.body, type: errorHandler.NO_CHANGE});
              return errorHandler.handleErrorMessage(res, 'Server error creating question', errorHandler.NO_CHANGE);
            }
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('createQuestion')))
      .then(() => metric.logUserRequest(req.body.id, 'createQuestion'))
      .catch(function creationError(err) {
        winston.error(err, {user: req.body.id, endpoint: 'createQuestion', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        return errorHandler.handleErrorMessage(res, 'Server error creating question', errorHandler.EXCEPTION);
      });
  });
});
