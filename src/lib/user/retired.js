// All registration occurs through facebook now
router.post('/register', (req, res) => {
  var registerGraphUrl = 'https://graph.facebook.com/v2.4/me?fields=id,name,location,picture.type(square).width(1000).height(1000)';
  if (req.body.facebookId) {
    if (!req.body.name) {
      return errorHandler.handleErrorMessage(res, 'No name given', errorHandler.BAD_INPUT);
    } else if (!req.body.location) {
      return errorHandler.handleErrorMessage(res, 'No location given', errorHandler.BAD_INPUT);
    } else if (!req.body.imageUrl) {
      return errorHandler.handleErrorMessage(res, 'No imageUrl given', errorHandler.BAD_INPUT);
    } else if (!req.body.largeImageUrl) {
      return errorHandler.handleErrorMessage(res, 'No largeImageUrl given', errorHandler.BAD_INPUT);
    } else if (!req.body.facebookId) {
      return errorHandler.handleErrorMessage(res, 'No Facebook identification given', errorHandler.BAD_INPUT);
    } else if (!req.body.birthday) {
      return errorHandler.handleErrorMessage(res, 'No birthday given', errorHandler.BAD_INPUT);
    } else if (!req.body.friendCount) {
      return errorHandler.handleErrorMessage(res, 'No user friend count', errorHandler.BAD_INPUT);
    } else {
      createAccount();
    }
  } else {
    var params = {
      client_id: req.body.clientId,
      redirect_uri: req.body.redirectUri,
      code: req.body.code,
      client_secret: secret
    };
    request.get({url: fbTokenApi, qs: params}, (err, response, token) => {
      req.body.accessToken = qs.parse(token);
      if (!req.body.accessToken) {
        winston.error('unable to sign in to facebook', {endpoint: 'register', type: errorHandler.BAD_REQUEST});
        return errorHandler.handleErrorMessage(res, 'Unable to sign in to Facebook since there was no access token', errorHandler.BAD_REQUEST);
      }
      request.get({url: registerGraphUrl, qs: req.body.accessToken, json: true}, (err, response, profile) => {
        if (profile.id) {
          req.body.name = profile.name;
          req.body.location = profile.location.name;
          req.body.imageUrl = profile.picture.data.url;
          req.body.facebookId = profile.id;
          createAccount();
        } else {
          winston.error('unable to sign in to facebook: ' + JSON.stringify(err), {endpoint: 'register', type: errorHandler.BAD_REQUEST});
          return errorHandler.handleErrorMessage(res, 'unable to sign in to Facebook', errorHandler.BAD_REQUEST);
        }
      });
    });
  }

  function createAccount() {
    r.db('user').table('logins')
      .getAll(req.body.facebookId, {index: 'facebookId'})
      .coerceTo('Array')
      .run()
      .then(result => {
        if (result.length > 0) {
          return errorHandler.handleErrorMessage(res, 'That Facebook account has already been linked to an account', errorHandler.BAD_REQUEST);
        }
        winston.info('Adding new user ' + req.body.facebookId);
        return r.db('user').table('users').insert({
            active: true,
            name: req.body.name,
            location: (req.body.location) ? req.body.location : '',
            imageUrl: req.body.imageUrl,
            largeImageUrl: req.body.largeImageUrl || req.body.imageUrl,
            friendCount: req.body.friendCount,
            birthday: req.body.birthday,
            gender: req.body.gender,
            requests: [],
            contacts: [],
            blockedUsers: [],
            blockedBy: [],
            createdOn: Date.now(),
            recognition: 10,
            aboutMe: ''
          })
          .run()
          .then(function(result) {
            if (result['generated_keys'].length === 0) {
              return errorHandler.handleErrorMessage(res, 'Problem inserting the user', errorHandler.NO_CHANGE);
            }
            req.body.id = result['generated_keys'][0];
            r.db('user').table('logins').insert({
              userId: req.body.id,
              facebookId: req.body.facebookId,
              registrationTokens: req.body.registrationToken ? [req.body.registrationToken] : [],
              iOSRegistrationTokens: req.body.iOSRegistrationToken ? [req.body.iOSRegistrationToken] : [],
              fbFriends: req.body.friends ? req.body.friends : []
            })
            .run()
            .then(function(resolution) {
              if (resolution['generated_keys'].length === 0) {
                errorHandler.handleErrorMessage(res, 'Problem inserting user login information', errorHandler.NO_CHANGE);
                // Clean up users table to remove previously added user
                return r.db('user').table('users')
                  .get(req.body.id)
                  .delete()
                  .run();
              } else {
                var response = {};
                response.id = resolution['generated_keys'][0];
                response.userId = req.body.id;
                auth.createSendToken(req, response, (tokenResult) => {
                  res.status(200).send(JSON.stringify(tokenResult, null, 2));
                  insertRecognitionHistory('You joined YoRally', req.body.id, 10, req.body.id, 'register');
                  metric.checkTotal(() => metric.updateTable('totals', {totalUsers: 1}));
                  metric.checkDaily(() => metric.updateTable('dailyMetrics', {users: req.body.id, newUsers: 1}));
                });
              }
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
});
