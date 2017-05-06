/*jslint node: true */
var config = rootRequire('config').rethinkdb;
var gcm = require('node-gcm');
var apiKey = rootRequire('config').googleApi;
var stackTrace = require('stack-trace');
var winston = rootRequire('log');
var errorHandler = rootRequire('error');

var notify = {};
var GCM_OPTIONS = {
  delayWhileIdle: true,
  priority: 'high'
}

notify.createNotification = function createNotification(r, user1, user2, type, item, viewed, deduplicate) {
  if (!viewed) {
    viewed = false;
  }
  var notificationContent = {
    user1: user1,
    user2: user2,
    item: item,
    type: type,
    time: Date.now(),
    viewed: viewed
  };

  if (type === 'confirmNotification') {
    sendNotification(r, notificationContent, null);
  } else if (deduplicate && type !== 'newRallyComment') {
    var filter = {viewed: false, type: type};
    if (type === 'message') {
      filter.user1 = user1;
    }
    return r.db('notification').table('events')
      .getAll(user2, {index: 'user2'})
      .filter(filter)
      .count()
      .run()
      .then(count => {
        if (count === 0) {
          return r.db('user').table('users')
            .get(user1)
            .run()
            .then(result => {
              // Don't send notification if the user is blocked
              if (result.blockedBy.indexOf(user2) === -1 && result.blockedUsers.indexOf(user2) === -1) {
                sendNotification(r, notificationContent, result);
              }
            });
        }
      })
      .catch(err => winston.error(err, {user: user2, trace: stackTrace.parse(err), type: errorHandler.EXCEPTION}));
  } else if (deduplicate) {
    r.db('notification').table('events')
      .getAll(user2, {index: 'user2'})
      .filter({viewed: false, type: type, item: item, user1: user1})
      .count()
      .run()
      .then(count => {
        if (count === 0) {
          return r.db('user').table('users')
            .get(user1)
            .run()
            .then(result => {
              // Don't send notification if the user is blocked
              if (result.blockedBy.indexOf(user2) === -1 && result.blockedUsers.indexOf(user2) === -1) {
                sendNotification(r, notificationContent, result);
              }
            });
        }
      })
      .catch(err => winston.error(err, {user: user2, trace: stackTrace.parse(err), type: errorHandler.EXCEPTION}));
  } else {
    r.db('user').table('users')
      .get(user1)
      .run()
      .then(result => {
        if (result.blockedBy.indexOf(user2) === -1 && result.blockedUsers.indexOf(user2) === -1) {
          sendNotification(r, notificationContent, result);
        }
      })
      .catch(err => winston.error(err, {user: user2, trace: stackTrace.parse(err), type: errorHandler.EXCEPTION}));
  }
}

function sendNotification(r, notificationContent, userData1) {
  return r.db('notification').table('events')
    .insert(notificationContent)
    .run()
    .then(result => {
      if (result.inserted === 0) {
        winston.error('Unable to insert notification into the events table', {endpoint: 'tools:createNotification()', type: errorHandler.NO_CHANGE});
        return;
      }
      notificationContent.id = result.generated_keys[0];
      // create GCM (Google Cloud Message) notification
      r.db('user').table('logins')
        .getAll(notificationContent.user2, {index: 'userId'})
        .run()
        .then(userLogin => {
          if (!userLogin) {
            winston.error('Notifying a user that does not have a login: ' + JSON.stringify(notificationContent), {endpoint: 'tools:createNotification()', type: errorHandler.BAD_REQUEST});
            return;
          }
          var payload = getNotificationPayload(notificationContent.type, userData1);
          var message, sender;
          if (userLogin[0].registrationTokens.length > 0) {
            message = new gcm.Message(GCM_OPTIONS);
            message.addData('title', payload.title);
            message.addData('image', payload.image);
            message.addData('body', payload.body);
            message.addData('ledColor', payload.ledColor);
            message.addData('vibrationPattern', payload.vibrationPattern);
            message.addData('notificationPayload', notificationContent);
            sender = new gcm.Sender(apiKey);
            sender.send(message, {registrationTokens: userLogin[0].registrationTokens}, (err, response) => {
              if (err) {
                winston.error(err, {endpoint: 'tools:createNotification()', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
              } else {
                console.log(response);
                removeErroringResults(r, notificationContent.user2, response.results, userLogin[0].registrationTokens, 'registrationTokens');
              }
            });
          }
          if (userLogin[0].iOSRegistrationTokens.length > 0) {
            message = new gcm.Message(GCM_OPTIONS);
            message.addNotification('title', payload.title);
            message.addNotification('body', payload.body);
            message.addData('notificationPayload', notificationContent);
            sender = new gcm.Sender(apiKey);
            sender.send(message, {registrationTokens: userLogin[0].iOSRegistrationTokens}, (err, response) => {
              if (err) {
                winston.error(err, {endpoint: 'tools:createNotification()', trace: stackTrace.parse(err), type: errorHandler.EXCEPTION});
              } else {
                console.log(response);
                removeErroringResults(r, notificationContent.user2, response.results, userLogin[0].iOSRegistrationTokens, 'iOSRegistrationTokens');
              }
            });
          }
        });
    })
    .catch(err => winston.error(err, {user: notificationContent.user2, trace: stackTrace.parse(err), type: errorHandler.EXCEPTION}));
}

function getNotificationPayload(type, user) {
  switch (type) {
    case 'confirmNotification':
      return {
        title: 'Welcome to YoRally',
        image: '',
        body: 'Click to open YoRally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'message':
      return {
        title: user.name + ' sent you a message',
        image: user.imageUrl,
        body: 'Click to open YoRally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'rallyInvite':
      return {
        title: user.name + ' invited you to Rally',
        image: user.imageUrl,
        body: 'Click to open YoRally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'rallyInviteAccepted':
      return {
        title: 'Invite Accepted',
        image: '',
        body: user.name + ' accepted your Rally invite',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'rallyRequest':
      return {
        title: 'Rally Request',
        image: '',
        body: user.name.split(' ')[0] + ' wants to join your Rally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'rallyRequestAccepted':
      return {
        title: 'Rally Request Accepted',
        image: '',
        body: user.name + ' accepted your Rally request',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'rallyAttendanceConfirmed':
      return {
        title: 'New Rallier',
        image: '',
        body: user.name + ' joined your Rally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'unconfirmRallyAttendance':
      return {
        title: 'Host can\'t make your rally',
        image: '',
        body: user.name + ' is no longer attending your rally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'leftRally':
      return {
        title: user.name + ' left your Rally',
        image: '',
        body: 'Click to open YoRally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'rallyUpdated':
      return {
        title: user.name + ' updated your Rally',
        image: '',
        body: 'Click to open YoRally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'contact':
      return {
        title: user.name + ' is now your Ally',
        image: user.imageUrl,
        body: 'Click to open YoRally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      };
    case 'contactRequest':
      return {
        title: user.name + ' wants to be your Ally',
        image: user.imageUrl,
        body: 'Click to open YoRally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      }
    case 'newComment':
      return {
        title: 'New Comment Reply',
        image: '',
        body: user.name.split(' ')[0] + ' commented on your comment',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      }
    case 'newContentComment':
      return {
        title: 'New Comment',
        image: '',
        body: user.name.split(' ')[0] + ' commented on your post',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      }
    case 'newRallyComment':
      return {
        title: 'New Rally Message',
        image: '',
        body: user.name + ' commented in your Rally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      }
    case 'userJoined':
      return {
        title: user.name + ' joined your Rally',
        image: user.imageUrl,
        body: 'Click to open YoRally',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      }
    case 'userAddInterest':
      return {
        title:  user.name + ' wants to Rally',
        image: user.imageUrl,
        body: user.name + ' is interested in your status',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      }
    case 'userRemoveInterest':
      return {
        title:  user.name + ' no longer wants to Rally',
        image: user.imageUrl,
        body: user.name + ' is no longer interested in your status',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      }
    case 'upcomingNotificationCron':
      return {
        title:  'Upcoming Rally',
        image: '',
        body: 'Remember to rally!',
        ledColor: [0, 0, 0, 255],
        vibrationPattern: [1000, 500]
      }
  }
}

function removeErroringResults(r, userId, results, tokens, tokenFieldName) {
  if (results.length !== tokens.length) {
    return;
  }
  let remainingTokens = tokens.map((token, index) => {
      return (!results[index].error || results[index].error !== 'NotRegistered') ? token : null;
    })
    .filter(token => token !== null);
  let updateObject = {};
  updateObject[tokenFieldName] = remainingTokens;
  r.db('user').table('logins')
    .getAll(userId, {index: 'userId'})
    .update(updateObject)
    .run()
    .then()
    .catch(err => winston.error(err, {user: userId, trace: stackTrace.parse(err), type: errorHandler.EXCEPTION}));
}

// function removeErroringiOSNotificationTokens(r, userId, results, tokens, index) {
//   if (results[index].error) {
//     r.db('user').table('logins')
//       .getAll(userId, {index: 'userId'})
//       .update({iOSRegistrationTokens: r.row('iOSRegistrationTokens').deleteAt(index)})
//       .run()
//       .then(function(result) {
//         if (--index >= 0) {
//           removeErroringiOSNotificationTokens(r, userId, results, tokens, index);
//         }
//       })
//       .catch(err => winston.error(err, {user: userId, trace: stackTrace.parse(err), type: errorHandler.EXCEPTION}));
//   }
// }
//
// function removeErroringNotificationTokens(r, userId, results, tokens, index) {
//   if (results[index].error) {
//     r.db('user').table('logins')
//       .getAll(userId, {index: 'userId'})
//       .update({registrationTokens: r.row('registrationTokens').deleteAt(index)})
//       .run()
//       .then(function(result) {
//         if (--index >= 0) {
//           removeErroringNotificationTokens(r, userId, results, tokens, index);
//         }
//       })
//       .catch(err => winston.error(err, {user: userId, trace: stackTrace.parse(err), type: errorHandler.EXCEPTION}));
//   }
// }

module.exports = notify;
