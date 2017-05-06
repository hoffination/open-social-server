/* globals rootRequire */
var jwt = require('jwt-simple');
var bcrypt = require('bcrypt-nodejs');
var config = rootRequire('config');
var secret = config.secret;
var winston = rootRequire('log');
var stackTrace = require('stack-trace');
var rethinkConfig = config.rethinkdb;
var r = require('rethinkdbdash')({servers: [rethinkConfig]});

var auth = {};
const VERSION = 'v1.0.7';

// Checks to make sure the user is authorized given their credentials
auth.checkAuth = function(req, res, callback) {
  try {
    if (!req.headers.authorization) {
      callback('You are not authorized');
    } else {
      var token = req.headers.authorization.split(' ')[1];
      var payload = jwt.decode(token, secret);
      if (!payload.sub) {
        callback('Authentication failed');
      } else if (payload.ver !== VERSION) {
        callback('Authentication token is outdated');
      }  else {
        callback();
      }
    }
  } catch(ex) {
    return callback('Authentication failed to be validated');
  }
}

auth.checkAuthAndId = function(req, res, userId, callback) {
  try {
    if (!req.headers.authorization) {
      callback('You are not authorized');
    } else {
      var token = req.headers.authorization.split(' ')[1];
      var payload = jwt.decode(token, secret);
      if (!payload.sub) {
        callback('Authentication failed');
      } else if (payload.sub !== userId) {
        callback('Authentication token is not associated with this user');
      } else if (payload.ver !== VERSION) {
        callback('Authentication token is outdated');
      } else {
        r.db('user').table('bannedUsers')
          .get(userId)
          .run()
          .then(result => {
            if (result) {
              callback('Unauthorized. User has been banned');
            } else {
              callback();
            }
          })
          .catch(err => {
            winston.warn('Unable to check banned table for user: ' + err, {trace: stackTrace.parse(err)});
            callback('Issue validating user')
          });
      }
    }
  } catch(ex) {
    return callback('Authentication failed to be validated');
  }
}

// TODO: reimplement this some day
// Overwrites the password variable after encrypting it
auth.encryptPassword = function(req, callback) {
  bcrypt.genSalt(1109303, function(err, salt) {
    if (err) {
      winston.warn('Error generating salt: ' + err, {trace: stackTrace.parse(err)});
      callback('error generating salt');
    } else {
      bcrypt.hash(req.body.password, salt, null, function(err, hash) {
        if (err) {
          // Log password to check for bad characters that the UI might have to deal with in the future
          winston.warn('Error encrypting password: ' + err,
            {password: req.body.password, trace: stackTrace.parse(err)});
          callback('error encrypting password');
        } else {
          req.body.password = hash;
          callback();
        }
      });
    }
  });
}

auth.createSendToken = function createSendToken(req, result, callback) {
  var payload = {
    iss: req.hostname,
    sub: result.userId,
    ver: VERSION
  }
  var token = jwt.encode(payload, secret);
  result.email = req.body.email;
  result.token = token;
  callback(result);
}

module.exports = auth;
