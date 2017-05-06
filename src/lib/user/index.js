/*globals rootRequire */
const dao = require('./dao');
const async = require('async');
const secret = rootRequire('config').fbSecret;
const fbTokenApi = rootRequire('config').fbTokenApi;
const express = require('express');
const auth = rootRequire('auth/auth.js');
const bcrypt = require('bcrypt-nodejs');
const request = require('request');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const qs = require('querystring');
const R = require('ramda');
const moment = require('moment');
const router = express.Router();
const winston = rootRequire('log');
const metric = rootRequire('metric');
const stackTrace = require('stack-trace');
const notify = rootRequire('tools/notify');
const mapper = rootRequire('tools/mappers');
const errorHandler = rootRequire('error');

// Upfront test of the related database and connection setup
router.use(passport.initialize());
passport.serializeUser((user, done) => {done(null, user.userId)});

var loginStrategy = new LocalStrategy({usernameField: 'email', passReqToCallback: true}, (req, email, password, done) => {
  dao.lookupLogin(email, {index: 'email'})
    .then(result => {
      if (result.length === 0) {
        return done('No user exists in our system with that email.', errorHandler.BAD_REQUEST);
      } else if (!result[0].password) {
        return done('User does not have a password to sign-in with', errorHandler.BAD_REQUEST);
      }
      bcrypt.compare(password, result[0].password, (err, match) => {
        if (err) {
          winston.error(err, {endpoint: 'register:loginStrategy:compare', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
          done('Error encrypting the password', errorHandler.EXCEPTION);
        } else if (!match) {
          done('Incorrect email/password combination', errorHandler.BAD_REQUEST);
        } else {
          done(null, null, result[0]);
        }
      });
    })
    .catch(err => {
      winston.error(err, {endpoint: 'register:loginStrategy', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
      done(err, errorHandler.EXCEPTION);
    })
});

passport.use(loginStrategy);

router.post('/login', function(req, res) {
  if (!req.body.email) {
    return errorHandler.handleErrorMessage(res, 'No email given', errorHandler.BAD_INPUT);
  }
  passport.authenticate('local', function(err, type, user) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else {
      req.login(user, function(err) {
        if (err) {
          return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
        } else {
          auth.createSendToken(req, user, loginCallback);
        }
      });
    }
  })(req, res, loginCallback);

  function loginCallback(result) {
    winston.info('User logged in: ' + req.body.email);
    res.status(200).send(JSON.stringify(result, null, 2));

    metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1}));
    metric.checkRequestedEndpoints(() => metric.markEndpointRequested('login'));
    metric.logUserRequest(req.body.id, 'login');
  }
});

router.post('/auth/facebook', function(req, res) {
  var registerGraphUrl;
  var params = { client_secret: secret };
  if (req.body.accessToken) {
    // Check permissions of user given access token to determine if they are a legitimate user
    registerGraphUrl = 'https://graph.facebook.com/' + req.body.userID + '/permissions?access_token=' + req.body.accessToken;

    request.get({url: registerGraphUrl, json: true}, function(err/*, response, profile*/) {
      if (err) {
        winston.error('unable to sign in to facebook: ' + JSON.stringify(err), {endpoint: 'auth.facebook', err: err, type: errorHandler.AUTH});
        return errorHandler.handleErrorMessage(res, 'unable to sign user in on Facebook', errorHandler.AUTH);
      } else {
        checkForAccount({id: req.body.userID || req.body.facebookId});
      }
    });
  } else {
    registerGraphUrl = 'https://graph.facebook.com/v2.4/me?fields=id,name,location,picture.type(square).height(120).width(120),friends,birthday,gender';
    params.client_id = req.body.clientId;
    params.redirect_uri = req.body.redirectUri;
    params.code = req.body.code;

    request.get({url: fbTokenApi, qs: params}, function(err, response, token) {
      let accessToken = qs.parse(token);
      request.get({url: registerGraphUrl, qs: accessToken, json: true}, function(err, response, profile) {
        if (profile.id){
          req.body.name = profile.name;
          req.body.location = profile.location ? profile.location.name : 'Unknown';
          req.body.imageUrl = profile.picture ? profile.picture.data.url : null;
          req.body.friendCount = profile.friends ? profile.friends.summary.total_count : null;
          req.body.birthday = profile.birthday;
          req.body.friends = profile.friends ? profile.friends.data.map(x => x.id) : null;
          req.body.gender = profile.gender;
          profile.token = accessToken;

          registerGraphUrl = 'https://graph.facebook.com/v2.4/me?fields=picture.type(square).width(480).height(480)'
          request.get({url: registerGraphUrl, qs: accessToken, json: true}, function(err, response, result) {
            req.body.largeImageUrl = result.picture ? result.picture.data.url : null;
            checkForAccount(profile);
          });
        } else {
          winston.error('unable to sign in to facebook: ' + JSON.stringify(err), {endpoint: 'auth.facebook', err: err, type: errorHandler.AUTH});
          return errorHandler.handleErrorMessage(res, 'unable to sign user in on Facebook', errorHandler.AUTH);
        }
      });
    });
  }

  function checkForAccount(profile) {
    dao.lookupLogin(profile.id, {index: 'facebookId'})
      .then(result => {
        if (result.length === 0) {
          if (req.body.acceptedUserAgreement) {
            createAccount(profile);
          } else {
            var retObject = {message: 'User needs to sign the user agreement'};
            retObject.type = 'pending';
            res.status(200).send(JSON.stringify(retObject, null, 2));
          }
        } else {
          auth.createSendToken(req, result[0], (tokenResult) => {
            req.body.id = result[0].userId;
            winston.info('User signed in using Facebook: ' + tokenResult.id);
            res.status(200).send(JSON.stringify(tokenResult, null, 2));

            if (req.body.registrationToken || req.body.iOSRegistrationToken || req.body.friends) {
              return dao.appendLoginData(tokenResult.id, req.body.registrationToken, req.body.iOSRegistrationToken, req.body.friends)
                .then(function(resolution) {
                  if (resolution.errors !== 0) {
                    winston.error('Unable to update login data', {endpoint: 'auth.facebook', type: errorHandler.NO_CHANGE});
                  }
                  // check if we need to update photos for S3
                  return dao.getUser(req.body.id)
                    .then(userData => {
                      if (!userData.photoId) {
                        return dao.getUUID(req.body.id)
                          .then((photoId) => {
                            return dao.setUserPhotoID(req.body.id, photoId)
                              .then(() => {
                                return dao.uploadFileToAwsFromUrl(req.body.imageUrl, 'small', photoId)
                                  .then(() => {
                                    return dao.uploadFileToAwsFromUrl(req.body.largeImageUrl, 'large', photoId)
                                      .then(() => winston.info('Uploaded user photos to s3 for user ' + req.body.id, {endpoint: 'auth.facebook'}))
                                  })
                              })
                          })
                      }
                    })
                })
            }
          });
        }
      })
      .then(() => {
        metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1}));
        metric.checkRequestedEndpoints(() => metric.markEndpointRequested('auth.facebook'));
        metric.logUserRequest(req.body.id, 'auth.facebook');
      })
      .catch(err => {
        winston.error(JSON.stringify(err), {endpoint: 'auth.facebook', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Problem finding or registering Facebook user', errorHandler.EXCEPTION);
      });
  }

  function createAccount(profile) {
    if (!req.body.name) {
      return errorHandler.handleErrorMessage(res, 'No name given', errorHandler.BAD_INPUT);
    } else if (!req.body.imageUrl) {
      return errorHandler.handleErrorMessage(res, 'No thumbnail profile image found', errorHandler.BAD_INPUT);
    } else if (!req.body.largeImageUrl) {
      return errorHandler.handleErrorMessage(res, 'No profile image found', errorHandler.BAD_INPUT);
    } else if (!req.body.birthday) {
      return errorHandler.handleErrorMessage(res, 'No birthday given', errorHandler.BAD_INPUT);
    } else if (!req.body.friendCount && req.body.friendCount !== 0) { // allow users with no facebook friends
      return errorHandler.handleErrorMessage(res, 'No user friend count', errorHandler.BAD_INPUT);
    } else {
      winston.info('Adding new user ' + req.body.facebookId);
      return dao.createUser({
          active: true,
          name: req.body.name,
          location: (req.body.location) ? req.body.location : '',
          // imageUrl: req.body.imageUrl,
          // largeImageUrl: req.body.largeImageUrl || req.body.imageUrl,
          friendCount: req.body.friendCount,
          birthday: req.body.birthday,
          gender: req.body.gender,
          requests: [],
          contacts: [],
          blockedUsers: [],
          blockedBy: [],
          createdOn: Date.now(),
          recognition: 10,
          aboutMe: '',
          sessions: 1,
          allyOnboardDismissed: false,
          homeOnboardDismissed: false
        })
        .then(function(result) {
          if (result['generated_keys'].length === 0) {
            return errorHandler.handleErrorMessage(res, 'Problem inserting the user\'s login', errorHandler.NO_CHANGE);
          }
          req.body.id = result['generated_keys'][0];
          return dao.getUUID(req.body.id)
            .then((photoId) => {
              return dao.setUserPhotoID(req.body.id, photoId)
                .then(() => {
                  return dao.createLogin({
                      userId: req.body.id,
                      facebookId: profile.id,
                      registrationTokens: req.body.registrationToken ? [req.body.registrationToken] : [],
                      iOSRegistrationTokens: req.body.iOSRegistrationToken ? [req.body.iOSRegistrationToken] : [],
                      fbFriends: req.body.friends ? req.body.friends : []
                    })
                    .then(function(resolution) {
                      if (resolution['generated_keys'].length === 0) {
                        errorHandler.handleErrorMessage(res, 'Problem inserting user login information', errorHandler.NO_CHANGE);
                        return dao.deleteUser(req.body.id); // cleanup failing user
                      } else {
                        return dao.uploadFileToAwsFromUrl(req.body.imageUrl, 'small', photoId)
                          .then(() => {
                            return dao.uploadFileToAwsFromUrl(req.body.largeImageUrl, 'large', photoId)
                              .then(() => {
                                var response = {};
                                response.id = resolution['generated_keys'][0];
                                response.userId = req.body.id;
                                auth.createSendToken(req, response, (tokenResult) => {
                                  res.status(200).send(JSON.stringify(tokenResult, null, 2));
                                  insertRecognitionHistory('You joined YoRally', req.body.id, 10, req.body.id, 'register');
                                  metric.checkTotal(() => metric.updateTable('totals', {totalUsers: 1}));
                                  metric.checkDaily(() => metric.updateTable('dailyMetrics', {users: req.body.id, newUsers: 1}));
                                });
                              })
                          })
                      }
                    })
                })
            })
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('register')))
        .then(() => metric.logUserRequest(req.body.id, 'register'))
        .catch(err => {
          winston.error(err, {endpoint: 'register', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem finding database ids for user', errorHandler.EXCEPTION);
        });
      }
  }
});

router.post('/updateRegistrationToken', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, err => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.registrationToken && !req.body.iOSRegistrationToken) {
      return errorHandler.handleErrorMessage(res, 'Cannot update registration tokens as none were provided', errorHandler.BAD_INPUT);
    } else {
      var retObject = {message: 'Successfully requested updating registration tokens'};
      retObject.type = 'ok';
      res.status(200).send(JSON.stringify(retObject, null, 2));

      if (!req.body.registrationToken) {
        req.body.registrationToken = null;
      } else if (!req.body.iOSRegistrationToken) {
        req.body.iOSRegistrationToken = null;
      }

      dao.getLoginId(req.body.id)
        .then(id => {
          return dao.appendLoginData(id, req.body.registrationToken, req.body.iOSRegistrationToken, [])
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('updateRegistrationToken')))
        .then(() => metric.logUserRequest(req.body.id, 'updateRegistrationToken'))
        .catch(err => {
          winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'updateRegistrationToken', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem accessing user database', errorHandler.EXCEPTION);
        });
    }
  })
});

router.post('/updateFacebookFriends', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, err => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.friends || !Array.isArray(req.body.friends)) {
      return errorHandler.handleErrorMessage(res, 'No friends list given', errorHandler.BAD_INPUT);
    } else {
      dao.getLoginId(req.body.id)
        .then(id => {
          return dao.appendLoginData(id, null, null, req.body.friends)
        })
        .then(() => {
          var retObject = {message: 'Successfully updated facebook friends'};
          retObject.type = 'ok';
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('updateFacebookFriends')))
        .then(() => metric.logUserRequest(req.body.id, 'updateFacebookFriends'))
        .catch(err => {
          winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'updateFacebookFriends', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem accessing user database', errorHandler.EXCEPTION);
        });
    }
  })
});

router.post('/getUser', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, err => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.userId) {
      return errorHandler.handleErrorMessage(res, 'No other user id given', errorHandler.BAD_INPUT);
    }
    dao.getUserFiltered(req.body.userId, ['aboutMe', 'admin', 'birthday', 'blockedUsers', 'contacts', 'createdOn', 'email', 'friendCount', 'homeCityId', 'id', 'imageUrl', 'largeImageUrl', 'location', 'name', 'requests', 'gender', 'sessions', 'homeOnboardDismissed', 'allyOnboardDismissed', 'photoId'])
      .then(result => {
        if (!result) {
          return errorHandler.handleErrorMessage(res, 'Unable to find user', errorHandler.BAD_REQUEST);
        }
        if (req.body.id !== req.body.userId) {
          delete result.blockedUsers;
          delete result.admin;
          delete result.sessions;
          delete result.allyOnboardDismissed;
          delete result.homeOnboardDismissed;
        }
        result.age = moment().diff(moment(result.birthday, "MM/DD/YYYY"), 'years');
        delete result.birthday;

        var retObject = {message: 'Successfully found user'};
        retObject.type = 'ok';
        retObject.result = result;
        res.status(200).send(JSON.stringify(retObject, null, 2));
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getUser')))
      .then(() => metric.logUserRequest(req.body.id, 'getUser'))
      .catch(err => {
        winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'getUser', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Problem accessing user database', errorHandler.EXCEPTION);
      });
  });
})

router.post('/sendFriendRequest', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.contactId) {
      return errorHandler.handleErrorMessage(res, 'No contactId given', errorHandler.BAD_INPUT);
    } else if (req.body.id === req.body.contactId) {
      return errorHandler.handleErrorMessage(res, 'Cannot add yourself as a friend', errorHandler.BAD_INPUT);
    }
    dao.getUser(req.body.contactId)
      .then(contact => {
        if (contact.requests.indexOf(req.body.id) !== -1) {
          return errorHandler.handleErrorMessage(res, 'You have already requested to be friends with this user', errorHandler.BAD_REQUEST);
        } else if (contact.contacts.indexOf(req.body.id) !== -1) {
          return errorHandler.handleErrorMessage(res, 'This user is already your contact', errorHandler.BAD_REQUEST);
        }
        return dao.getUser(req.body.id)
          .then(user => {
            if (user.requests.indexOf(req.body.contactId) !== -1) {
              return errorHandler.handleErrorMessage(res, 'This user already requested to be friends', errorHandler.BAD_REQUEST);
            }
            return dao.addUserRequest(req.body.contactId, req.body.id)
              .then(result => {
                if (result.unchanged > 0) {
                  winston.error('Unable to send contact request to ' + req.body.contactId, {user: req.body.id, endpoint: 'sendFriendRequest', type: errorHandler.NO_CHANGE});
                  return errorHandler.handleErrorMessage(res, 'Unable to send friend request', errorHandler.NO_CHANGE);
                }
                var retObject = {message: 'Successfully sent contact request'};
                retObject.type = 'ok';
                res.status(200).send(JSON.stringify(retObject, null, 2));
                notify.createNotification(r, req.body.id, req.body.contactId, 'contactRequest', null);
              })
          })
      })
      .then(() => metric.checkTotal(() => metric.updateTable('totals', {totalContactRequests: 1})))
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('sendFriendRequest')))
      .then(() => metric.logUserRequest(req.body.id, 'sendFriendRequest'))
      .catch(err => {
        winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'sendFriendRequest', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Server error sending request', errorHandler.EXCEPTION);
      });
  });
});

router.post('/getFriendRequests', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else {
      dao.getUserRequests(req.body.id)
        .then(result => {
          var retObject = {message: 'Successfully received contact requests'};
          retObject.type = 'ok';
          retObject.requests = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getFriendRequests')))
        .then(() => metric.logUserRequest(req.body.id, 'getFriendRequests'))
        .catch(err => {
          winston.error(err, {user: req.body.id, endpoint: 'getFriendRequests', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem getting friend requests', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/deleteFriendRequest', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.contactId) {
      return errorHandler.handleErrorMessage(res, 'No contactId given', errorHandler.BAD_INPUT);
    } else {
      dao.removeUserRequest(req.body.id, req.body.contactId)
        .then(result => {
          if (result.unchanged > 0) {
            return errorHandler.handleErrorMessage(res, 'Unable to delete friend request', errorHandler.NO_CHANGE)
          }
          var retObject = {message: 'Successfully deleted contact request'};
          retObject.type = 'ok';
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deleteFriendRequest')))
        .then(() => metric.logUserRequest(req.body.id, 'deleteFriendRequest'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'deleteFriendRequest', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem getting friend requests', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/acceptFriendRequest', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.contactId) {
      return errorHandler.handleErrorMessage(res, 'No contactId given', errorHandler.BAD_INPUT);
    } else {
      dao.getUser(req.body.id)
        .then(userData => {
          if (!userData.requests || userData.requests.indexOf(req.body.contactId) === -1) {
            return errorHandler.handleErrorMessage(res, 'Unable to accept a request that does not exist', errorHandler.BAD_REQUEST);
          }
          return dao.addContact(req.body.id, req.body.contactId)
            .then(result => {
              if (result.unchanged > 0) {
                return errorHandler.handleErrorMessage(res, 'Unable to accept friend request', errorHandler.NO_CHANGE, 'acceptFriendRequest')
              }
              insertRecognitionHistory('You added a contact', req.body.id, 2, req.body.contactId, 'acceptFriendRequest');
              return dao.addContact(req.body.contactId, req.body.id)
                .then(result => {
                  if (result.unchanged > 0) {
                    errorHandler.handleErrorMessage(res, 'Unable to accept friend request', errorHandler.NO_CHANGE, 'acceptFriendRequest')
                    // Roll back user data to original data
                    return dao.updateUser(req.body.id, userData)
                  }
                  insertRecognitionHistory('You added a contact', req.body.contactId, 2, req.body.id, 'acceptFriendRequest');
                  var retObject = {message: 'Successfully accepted friend request'};
                  retObject.type = 'ok';
                  res.status(200).send(JSON.stringify(retObject, null, 2));
                  notify.createNotification(r, req.body.id, req.body.contactId, 'contact', null, true);
                })
            })
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('acceptFriendRequest')))
        .then(() => metric.logUserRequest(req.body.id, 'acceptFriendRequest'))
        .catch(err => {
          winston.error(err, {user: req.body.id, endpoint: 'acceptFriendRequest', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem adding contact to contact list', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getContacts', function getContacts(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else {
      dao.getUserContacts(req.body.id)
        .then(result => {
          var retObject = {message: 'Successfully gathered contacts'};
          retObject.type = 'ok';
          retObject.contacts = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getContacts')))
        .then(() => metric.logUserRequest(req.body.id, 'getContacts'))
        .catch(function(err) {
          winston.error(err, {user: req.body.id, endpoint: 'getContacts', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem inserting notification', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getAllyData', function getAllyData(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else {
      async.parallel({
        contacts: (callback) => {
          dao.getUserContactStatuses(req.body.id)
            .then(result => callback(null, result))
            .catch(err => callback(err));
        },
        messageCount: (callback) => {
          dao.getUserMessageCounts(req.body.id)
            .then(result => {
              if (result) {
                callback(null, result.counts)
              } else {
                callback(null, {});
              }
            })
            .catch(err => callback(err));
        },
        rallyCount: (callback) => {
          dao.getUserRallyCounts(req.body.id)
            .then(result => {
              if (result) {
                callback(null, result.counts)
              } else {
                callback(null, {});
              }
            })
            .catch(err => callback(err));
        },
        upcomingAllyRallies: (callback) => {
          dao.getUserContacts(req.body.id)
            .then(contacts => {
              return dao.getRalliesWithOpenInvites(req.body.id)
                .then(rallyIds => {
                  return dao.getVisibleRallies(req.body.id, contacts, rallyIds)
                    .then(rallies => {
                      var contactsArray = {};
                      for (var i = 0; i < rallies.length; i++) {
                        if (rallyIds.indexOf(rallies[i].id) !== -1) {
                          rallies[i].isPending = true;
                        }
                        contacts.forEach(contact => {
                          if (!contactsArray[contact]) {
                            contactsArray[contact] = [];
                          }
                          if (R.contains(contact, rallies[i].confirmedUsers)) {
                            contactsArray[contact].push(mapper.mapRallyData(R.clone(rallies[i]), req.body.id, [contact]));
                          }
                        })

                        if (i === rallies.length - 1) {
                          callback(null, contactsArray);
                        }
                      }
                      if (rallies.length === 0) {
                        callback(null, contactsArray);
                      }
                    })
                })
            })
            .catch(err => callback(err));
        }
      }, (err, results) => {
        if (err) {
          winston.error(err, {user: req.body.id, endpoint: 'getAllyData', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          return errorHandler.handleErrorMessage(res, 'Serious server issue getting ally data', errorHandler.EXCEPTION);
        }

        results.contacts = results.contacts.map(function(contact) {
          if (contact.status) {
            contact.status.isInterested = contact.status.interestedUsers.indexOf(req.body.id) !== -1;
            delete contact.status.interestedUsers;
          }
          if (results.upcomingAllyRallies[contact.id]) {
            contact.upcomingRallies = results.upcomingAllyRallies[contact.id];
          } else {
            contact.upcomingRallies = [];
          }
          contact.messageCount = results.messageCount[contact.id] || 0;
          contact.rallyCount = results.rallyCount[contact.id] || 0;
          return contact;
        })
        delete results.upcomingAllyRallies;
        delete results.messageCount;
        delete results.rallyCount;

        var retObject = {message: 'Successfully gathered contacts'};
        retObject.type = 'ok';
        retObject.contacts = results.contacts;
        res.status(200).send(JSON.stringify(retObject, null, 2));

        metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1}));
        metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getAllyData'));
        metric.logUserRequest(req.body.id, 'getAllyData');
      });
    }
  })
});

router.post('/deleteContact', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.contactId) {
      return errorHandler.handleErrorMessage(res, 'No contactId given', errorHandler.BAD_INPUT);
    } else {
      dao.removeContact(req.body.id, req.body.contactId)
        .then(result => {
          if (result.unchanged > 0) {
            return errorHandler.handleErrorMessage(res, 'Unable to remove ally', errorHandler.NO_CHANGE);
          }
          return dao.removeContact(req.body.contactId, req.body.id)
            .then(result => {
              if (result.unchanged > 0) {
                return errorHandler.handleErrorMessage(res, 'Unable to remove ally', errorHandler.EXCEPTION, 'deleteContact');
              }
              var retObject = {message: 'Successfully deleted contact request'};
              retObject.type = 'ok';
              res.status(200).send(JSON.stringify(retObject, null, 2));
              // Remove user recognitionHistory
              return dao.removeRecognitionHistoryItem(req.body.id, req.body.contactId, 'You added a contact')
                .then(result => {
                  // remove other contact recognitionHistory
                  return dao.removeRecognitionHistoryItem(req.body.contactId, req.body.id, 'You added a contact')
                    .then(otherResult => {
                      if (result.deleted === 0 || otherResult.deleted === 0) {
                        winston.error('unable to delete recognition history', {user: req.body.id, endpoint: 'deleteContact', type: errorHandler.NO_CHANGE});
                      }
                      // Remove Interest in statuses for both users
                      return dao.removeStatusInterest(req.body.id, req.body.contactId)
                    })
                })
            })
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('deleteContact')))
        .then(() => metric.logUserRequest(req.body.id, 'deleteContact'))
        .catch(err => {
          winston.error(err, {user: req.body.id, endpoint: 'deleteContact', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem deleting contact', errorHandler.EXCEPTION);
        });
    }
  });
});

// Returns a list of all contacts that both users have on their contact lists
router.post('/getCommonContacts', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.contactId) {
      return errorHandler.handleErrorMessage(res, 'No contactId given', errorHandler.BAD_INPUT);
    } else {
      dao.getCommonContacts(req.body.id, req.body.contactId)
        .then(result => {
          var retObject = {message: 'Successfully gathered common contacts'};
          retObject.type = 'ok';
          retObject.contacts = result;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getCommonContacts')))
        .then(() => metric.logUserRequest(req.body.id, 'getCommonContacts'))
        .catch(err => {
          winston.error(err, {user: req.body.id, endpoint: 'getCommonContacts', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem getting common contacts', errorHandler.EXCEPTION);
        });
    }
  });
});

// Should allow you to see public rallies your friends are going to and protected rallies your friends are hosting
router.post('/getContactActivities', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else {
      dao.getUserContactsToLists(req.body.id)
        .then(contacts => {
          if (!contacts || Object.keys(contacts).length === 0) {
            var retObject = {message: 'Successfully gathered my contact activities'};
            retObject.type = 'ok';
            retObject.activities = [];
            res.status(200).send(JSON.stringify(retObject, null, 2));
          } else if (req.body.userId && Object.keys(contacts).indexOf(req.body.userId) !== -1) {
            return dao.getUserInvitesFromContact(req.body.id, req.body.userId)
              .then(invitedRallies => {
                return dao.getVisibleRalliesForContact(req.body.id, req.body.userId, contacts, invitedRallies)
                  .then(activities => {
                    var retObject = {message: 'Successfully gathered my contact activities'};
                    retObject.type = 'ok';
                    retObject.activities = activities.map(x => {
                      x.isPending = invitedRallies.indexOf(x.id) !== -1;
                      return mapper.mapRallyData(x, req.body.id, Object.keys(contacts))
                    });
                    return res.status(200).send(JSON.stringify(retObject, null, 2));
                  })
              })
          } else {
            return dao.getRalliesWithOpenInvites(req.body.id)
              .then(rallyIds => {
                return dao.getVisibleRallies(req.body.id, contacts, rallyIds)
                  .then(activities => {
                    let retObject;
                    for (var i = 0; i < activities.length; i++) {
                      Object.keys(contacts).forEach(contact => {
                        if (R.contains(contact, activities[i].confirmedUsers)) {
                          contacts[contact].push(mapper.mapRallyData(R.clone(activities[i]), req.body.id, Object.keys(contacts)))
                        }
                      })

                      if (i === activities.length - 1) {
                        retObject = {message: 'Successfully gathered my contact activities'};
                        retObject.type = 'ok';
                        retObject.activities = contacts;
                        res.status(200).send(JSON.stringify(retObject, null, 2));
                        return;
                      }
                    }
                    if (activities.length === 0) {
                      retObject = {message: 'Successfully gathered my contact activities'};
                      retObject.type = 'ok';
                      retObject.activities = contacts;
                      res.status(200).send(JSON.stringify(retObject, null, 2));
                      return;
                    }
                  })
              })
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getContactActivities')))
        .then(() => metric.logUserRequest(req.body.id, 'getContactActivities'))
        .catch(err => {
          winston.error(err, {user: req.body.id, endpoint: 'getContactActivities', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying get contact activities', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/getRecognition', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else {
      dao.getRecognition(req.body.id)
        .then(result => {
          var retObject = {message: 'Successfully gathered recognition'};
          retObject.type = 'ok';
          retObject.recognition = result.recognition;
          res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getRecognition')))
        .then(() => metric.logUserRequest(req.body.id, 'getRecognition'))
        .catch(err => {
          winston.error(err, {user: req.body.id, endpoint: 'getRecognition', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying get Recognition', errorHandler.EXCEPTION);
        });
    }
  });
});

router.post('/updateAboutMe', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, (err) => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.aboutMe && typeof req.body.aboutMe === 'undefined') {
      return errorHandler.handleErrorMessage(res, 'Missing about me', errorHandler.BAD_INPUT);
    } else {
      dao.updateUserAboutMe(req.body.id, req.body.aboutMe)
        .then(result => {
          if (result.replaced === 0) {
            return errorHandler.handleErrorMessage(res, 'Unable to change bio', errorHandler.NO_CHANGE);
          } else {
            var retObject = {message: 'Successfully updated about me'};
            retObject.type = 'ok';
            res.status(200).send(JSON.stringify(retObject, null, 2));
          }
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('updateAboutMe')))
        .then(() => metric.logUserRequest(req.body.id, 'updateAboutMe'))
        .catch(err => {
          winston.error(err, {user: req.body.id, endpoint: 'updateAboutMe', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Encountered error trying to update about me', errorHandler.EXCEPTION);
        });
    }
  })
})

router.post('/addToBlockedUsers', (req, res) => {
  if (!req.body.userId) {
    return errorHandler.handleErrorMessage(res, 'No user id to block given', errorHandler.BAD_INPUT);
  } else {
    auth.checkAuthAndId(req, res, req.body.id, err => {
      if (err) {
        return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
      }
      dao.addBlockedUser(req.body.id, req.body.userId)
        .then(result => {
          if (result.unchanged !== 0) {
            return errorHandler.handleErrorMessage(res, 'User is already in your blocked user list', errorHandler.NO_CHANGE);
          }
          dao.addBlockingUser(req.body.userId, req.body.id)
            .then(result => {
              if (result.unchanged !== 0) {
                return errorHandler.handleErrorMessage(res, 'User is already in your blocked user list', errorHandler.NO_CHANGE, 'addToBlockedUsers');
              }
              var retObject = {message: 'Successfully added user to blocked users list'};
              retObject.type = 'ok';
              return res.status(200).send(JSON.stringify(retObject, null, 2));
            })
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('addToBlockedUsers')))
        .then(() => metric.logUserRequest(req.body.id, 'addToBlockedUsers'))
        .catch(err => {
          winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'addToBlockedUsers', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem accessing user database', errorHandler.EXCEPTION);
        });
    });
  }
})

router.post('/removeBlockFromUser', (req, res) => {
  if (!req.body.userId) {
    return errorHandler.handleErrorMessage(res, 'No user id to unblock given', errorHandler.BAD_INPUT);
  } else {
    auth.checkAuthAndId(req, res, req.body.id, err => {
      if (err) {
        return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
      }
      dao.removeBlockedUser(req.body.id, req.body.userId)
        .then(result => {
          if (result.unchanged !== 0) {
            return errorHandler.handleErrorMessage(res, 'User is not in your blocked user list', errorHandler.NO_CHANGE);
          }
          dao.removeBlockingUser(req.body.userId, req.body.id)
            .then(result => {
              if (result.unchanged !== 0) {
                return errorHandler.handleErrorMessage(res, 'User is not in your blocked user list', errorHandler.NO_CHANGE, 'removeBlockFromUser');
              }
              var retObject = {message: 'Successfully removed user to blocked users list'};
              retObject.type = 'ok';
              return res.status(200).send(JSON.stringify(retObject, null, 2));
            })
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('removeBlockFromUser')))
        .then(() => metric.logUserRequest(req.body.id, 'removeBlockFromUser'))
        .catch(err => {
          winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'removeBlockFromUser', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem accessing user database', errorHandler.EXCEPTION);
        });
    });
  }
})

router.post('/getFacebookId', (req, res) => {
  if (!req.body.userId) {
    return errorHandler.handleErrorMessage(res, 'No user id given', errorHandler.BAD_INPUT);
  } else {
    auth.checkAuthAndId(req, res, req.body.id, err => {
      if (err) {
        return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
      }
      dao.getFacebookId(req.body.userId)
        .then(ids => {
          var retObject = {message: 'Successfully gathered user\'s facebookId'};
          retObject.type = 'ok';
          retObject.facebookId = ids[0];
          return res.status(200).send(JSON.stringify(retObject, null, 2));
        })
        .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
        .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getFacebookId')))
        .then(() => metric.logUserRequest(req.body.id, 'getFacebookId'))
        .catch(err => {
          winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'getFacebookId', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
          errorHandler.handleErrorMessage(res, 'Problem accessing user database', errorHandler.EXCEPTION);
        });
    });
  }
});

router.post('/getFacebookImportList', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, err => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    dao.getFacebookId(req.body.id)
      .then(ids => {
        dao.getUserContacts(req.body.id)
          .then(contacts => {
            dao.getImportableFacebookFriends(ids[0])
              .then(users => {
                var retObject = {message: 'Successfully gathered importable facebook users'};
                retObject.type = 'ok';
                retObject.users = users.filter(x => !R.contains(x.id, contacts)); // filter out friends
                return res.status(200).send(JSON.stringify(retObject, null, 2));
              })
          })
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('getFacebookImportList')))
      .then(() => metric.logUserRequest(req.body.id, 'getFacebookImportList'))
      .catch(err => {
        winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'getFacebookImportList', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Problem accessing user database', errorHandler.EXCEPTION);
      });
  });
});

router.post('/logSession', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, err => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    }
    dao.logUserSession(req.body.id)
      .then(result => {
        var retObject = {message: 'Successfully logged user session'};
        retObject.sessions = result.changes.length > 0 ? result.changes[0].new_val.sessions : 0;
        retObject.type = 'ok';
        return res.status(200).send(JSON.stringify(retObject, null, 2));
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('logSession')))
      .then(() => metric.logUserRequest(req.body.id, 'logSession'))
      .catch(err => {
        winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'logSession', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Problem logging session', errorHandler.EXCEPTION);
      });
  })
});

router.post('/dismissOnboard', (req, res) => {
  auth.checkAuthAndId(req, res, req.body.id, err => {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.type || (req.body.type !== 'home' && req.body.type !== 'ally')) {
      return errorHandler.handleErrorMessage(res, 'No valid onboard setting found', errorHandler.BAD_INPUT);
    }
    let updateObject = {};
    if (req.body.type === 'ally') {
      updateObject.allyOnboardDismissed = true;
    }
    if (req.body.type === 'home') {
      updateObject.homeOnboardDismissed = true;
    }

    dao.updateUserReturnChanges(req.body.id, updateObject)
      .then(result => {
        if (result.changes.length === 0) {
          return errorHandler.handleErrorMessage(res, 'Unable to update onboard view status', errorHandler.NO_CHANGE);
        }
        var retObject = {message: 'Successfully dismissed onboarding for a view'};
        retObject.type = 'ok';
        return res.status(200).send(JSON.stringify(retObject, null, 2));
      })
      .then(() => metric.checkDaily(() => metric.updateTable('dailyMetrics', {requests: 1})))
      .then(() => metric.checkRequestedEndpoints(() => metric.markEndpointRequested('dismissOnboard')))
      .then(() => metric.logUserRequest(req.body.id, 'dismissOnboard'))
      .catch(err => {
        winston.error(JSON.stringify(err), {user: req.body.id, endpoint: 'dismissOnboard', trace: stackTrace.parse(err), reqBody: req.body, type: errorHandler.EXCEPTION});
        errorHandler.handleErrorMessage(res, 'Problem updating onboarding for user', errorHandler.EXCEPTION);
      });
  })
});

// ---------------------------- Supporting Functions -------------------------------------------

function insertRecognitionHistory(type, userId, points, typeId, endpoint) {
  dao.insertRecognitionHistory(type, userId, points, typeId)
    .then(result => {
      if (result.inserted === 0) {
        winston.error('unable to insert recognition history', {user: userId, endpoint: endpoint});
      }
    })
    .catch(err => winston.error(err, {user: userId, endpoint: endpoint, trace: stackTrace.parse(err)}));
}

module.exports = router;
