/*globals rootRequire */
const config = rootRequire('config');
const r = require('rethinkdbdash')({servers: [config.rethinkdb]});
const request = require('request');
const AWS = require('aws-sdk');
AWS.config.update(config.awsAccess);
const s3 = new AWS.S3();

let service = {};

service.createLogin = (obj) => {
  return r.db('user').table('logins')
    .insert(obj)
    .run()
}

service.getLogin = (id) => {
  return r.db('user').table('logins')
    .get(id)
    .run()
}

service.getLoginId = (userId) => {
  return r.db('user').table('logins')
    .getAll(userId, {index: 'userId'})
    .getField('id')
    .run()
}

service.lookupLogin = (matchItem, indexObject) => {
  return r.db('user').table('logins')
    .getAll(matchItem, indexObject)
    .coerceTo('Array')
    .run()
}

service.appendLoginData = (id, token, iOSToken, friends) => {
  return r.db('user').table('logins')
    .get(id)
    .update({
      registrationTokens: r.branch(r.expr(!!token), r.row('registrationTokens').setInsert(token || 'badToken'), r.row('registrationTokens')),
      iOSRegistrationTokens: r.branch(r.expr(!!iOSToken), r.row('iOSRegistrationTokens').setInsert(iOSToken || 'badToken'), r.row('iOSRegistrationTokens')),
      fbFriends: r.row('fbFriends').setUnion(r.expr(friends || []))
    })
    .run()
}

service.deleteLogin = (id) => {
  return r.db('user').table('logins')
    .get(id)
    .delete()
    .run()
}

service.getFacebookId = (userId) => {
  return r.db('user').table('logins')
    .getAll(userId, {index: 'userId'})
    .getField('facebookId')
    .coerceTo('array')
    .run()
}

service.getImportableFacebookFriends = (id) => {
  return r.db('user').table('logins')
    .filter(r.row('fbFriends').contains(id))
    .eqJoin('userId', r.db('user').table('users'))('right')
    .pluck('aboutMe', 'contacts', 'email', 'friendCount', 'homeCityId', 'id', 'photoId', 'name', 'requests', 'location')
    .coerceTo('array')
    .run()
}

service.createUser = (obj) => {
  return r.db('user').table('users')
    .insert(obj)
    .run()
}

service.getUser = (id) => {
  return r.db('user').table('users')
    .get(id)
    .run()
}

service.getUserFiltered = (id, pluck) => {
  return r.db('user').table('users')
    .get(id)
    .pluck(r.args(pluck))
    .run()
}

service.updateUser = (id, userData) => {
  return r.db('user').table('users')
    .get(id)
    .update(userData)
    .run()
}

service.updateUserReturnChanges = (id, userData) => {
  return r.db('user').table('users')
    .get(id)
    .update(userData, {returnChanges: true})
    .run()
}

service.deleteUser = (id) => {
  return r.db('user').table('users')
    .get(id)
    .delete()
    .run()
}

service.getUUID = (seed) => {
  return r.uuid(seed).run()
}

service.setUserPhotoID = (id, photoId) => {
  return r.db('user').table('users')
    .get(id)
    .update({photoId: photoId})
    .run()
}

service.updateUserAboutMe = (id, aboutMe) => {
  return r.db('user').table('users')
    .get(id)
    .update({ aboutMe: aboutMe })
    .run()
}

service.logUserSession = (id) => {
  return r.db('user').table('users')
    .get(id)
    .update({sessions: r.row('sessions').add(1)}, {returnChanges: true})
    .run()
}

service.addBlockedUser = (id, contactId) => {
  return r.db('user').table('users')
    .get(id)
    .update({blockedUsers : r.row('blockedUsers').setInsert(contactId)})
    .run()
}

service.removeBlockedUser = (id, contactId) => {
  return r.db('user').table('users')
    .get(id)
    .update({
      blockedUsers : r.row('blockedUsers').filter(u => u.eq(contactId).not())
    })
    .run()
}

service.addBlockingUser = (id, contactId) => {
  return r.db('user').table('users')
    .get(id)
    .update({blockedBy : r.row('blockedBy').setInsert(contactId)})
    .run()
}

service.removeBlockingUser = (id, contactId) => {
  return r.db('user').table('users')
    .get(id)
    .update({
      blockedBy : r.row('blockedBy').filter(u => u.eq(contactId).not())
    })
    .run()
}

service.getUserRequests = (id) => {
  return r.db('user').table('users')
    .get(id)
    .getField('requests')
    .coerceTo('array')
    .run()
}

service.addUserRequest = (id, requestId) => {
  return r.db('user').table('users')
    .get(id)
    .update({requests: r.row('requests').setInsert(requestId)})
    .run()
}

service.removeUserRequest = (id, requestId) => {
  return r.db('user').table('users')
    .get(id)
    .update({requests: r.row('requests').filter(r => r.eq(requestId).not())})
    .run()
}

service.getUserContacts = (id) => {
  return r.db('user').table('users')
    .get(id)
    .getField('contacts')
    .coerceTo('array')
    .run()
}

service.getCommonContacts = (id, contactId) => {
  return r.db('user').table('users')
    .get(contactId)
    .getField('contacts')
    .coerceTo('Array')
    .setIntersection(r.db('user').table('users')
      .get(id)
      .getField('contacts')
      .coerceTo('Array'))
    .run()
}

service.addContact = (id, contactId) => {
  return r.db('user').table('users')
    .get(id)
    .update({
      contacts: r.row('contacts').setInsert(contactId),
      requests: r.row('requests').filter(r => r.eq(contactId).not()),
      recognition: r.row('recognition').add(2)
    })
    .run()
}

service.removeContact = (id, contactId) => {
  r.db('user').table('users')
    .get(id)
    .update({
      contacts: r.row('contacts').filter(c => c.eq(contactId).not()),
      recognition: r.row('recognition').add(-2)
    })
    .run()
}

// { ... contactId: [], ...}
service.getUserContactsToLists = (id) => {
  return r.db('user').table('users')
    .get(id)('contacts')
    .map(contact => r.object(contact, []))
    .reduce((left, right) => left.merge(right))
    .run()
}

service.getUserContactStatuses = (id) => {
  return r.db('user').table('users')
    .get(id)
    .getField('contacts')
    .map(function(userId) {
      return r.object(
          'id', userId,
          'status', r.db('user').table('status').get(userId),
          'lastActive', r.branch(r.db('metric').table('userLastActive').getField('id').contains(userId),
                                  r.db('metric').table('userLastActive').get(userId).getField('timestamp'),
                                  null)
        );
    })
    .eqJoin('id', r.db('user').table('users'))
    .zip()
    .pluck('id', 'photoId', 'name', 'status', 'lastActive')
    .run()
}

service.removeStatusInterest = (id, contactId) => {
  let idents = [id, contactId]
  return r.db('user').table('status')
    .getAll(r.args(idents))
    .update({
      interestedUsers: r.row('interestedUsers').filter(user => r.expr(idents).contains(user).not())
    })
    .run()
}

service.getUserMessageCounts = (id) => {
  return r.db('user').table('messageCounts')
    .get(id)
    .run()
}

service.getUserRallyCounts = (id) => {
  return r.db('user').table('rallyCounts')
    .get(id)
    .run()
}

service.getUserInvitesFromContact = (id, contactId) => {
  return r.db('forum').table('rallyInvites')
    .getAll(id, {index: 'to'})
    .filter({from: contactId, isPending: true})
    .getField('rallyId')
    .coerceTo('array')
}

service.getRalliesWithOpenInvites = (id) => {
  return r.db('forum').table('rallyInvites')
    .getAll(id, {index: 'to'})
    .filter({isPending: true})
    .getField('rallyId')
    .coerceTo('array')
    .run()
}

service.getVisibleRallies = (id, contacts, rallyIds) => {
  return r.db('forum').table('content')
    .getAll('rally', {index: 'type'})
    .filter(rally => {
      return rally('confirmedUsers').setIntersection(contacts).isEmpty().not()
        .and(rally('creator').eq(id)
          .or(rally('privacy').eq('public'))
          .or(rally('confirmedUsers').setUnion(rally('members')).contains(id))
          .or(r.expr(rallyIds).contains(rally('id')))
          .or(
            r.expr(contacts).contains(rally('creator'))
              .and(rally('privacy').eq('protected'))
          ))
        .and(rally('endDate').gt(Date.now()))
    })
    .without('address', 'declined', 'declinedCount', 'lastHeuristicUpdate', 'lastModified', 'requestCount')
    .coerceTo('array')
    .run()
}

service.getVisibleRalliesForContact = (id, contactId, contacts, invitedRallies) => {
  return r.db('forum').table('content')
    .getAll('rally', {index: 'type'})
    .filter(rally => {
      return rally('endDate').gt(Date.now())
      .and(
        rally('confirmedUsers').contains(contactId)
          .and(
            rally('privacy').eq('public')
            .or(
              rally('privacy').eq('private')
              .and(
                rally('confirmedUsers').contains(id)
                .or(rally('members').contains(id))
              )
            )
            .or(rally('privacy').eq('protected')
              .and(r.expr(Object.keys(contacts)).append(id).contains(rally('creator'))))
          )
      )
      .or(r.expr(invitedRallies).contains(rally('id')))
    })
    .without('address', 'declined', 'lastHeuristicUpdate', 'lastModified', 'requestCount')
    .coerceTo('array')
    .run()
}

service.getRecognition = (id) => {
  return r.db('user').table('users')
    .get(id)
    .pluck('recognition')
    .run()
}

service.insertRecognitionHistory = (type, userId, points, typeId) => {
  return r.db('user').table('recognitionHistory')
    .insert({
      tsCreated: Date.now(),
      type: type,
      userId: userId,
      points: points,
      typeId: typeId
    })
    .run()
}

service.removeRecognitionHistoryItem = (id, typeId, type) => {
  return r.db('user').table('recognitionHistory')
    .getAll(id, {index: 'userId'})
    .filter({typeId: typeId, type: type})
    .limit(1)
    .delete()
    .run()
}

// http://stackoverflow.com/questions/16803293/is-there-a-way-to-upload-to-s3-from-a-url-using-node-js
service.uploadFileToAwsFromUrl = (url, sizeString, photoId) => {
  var deferred = Promise.defer();
  request({
      url: url,
      encoding: null
  }, function(err, res, body) {
      if (err) {
        return deferred.reject(err);
      }
      s3.putObject({
        ACL: 'public-read',
        Bucket: config.awsBucket,
        Key: 'user_' + sizeString + '_' + photoId + '.jpg',
        ContentType: 'image/jpeg',
        ContentLength: res.headers['content-length'],
        StorageClass: 'STANDARD',
        Body: body // buffer
      }, () => {
        return deferred.resolve();
      });
  })
  return deferred.promise;
}

module.exports = service;

// service.uploadFileToAwsFromUrl('https://cdnb3.artstation.com/p/users/avatars/000/069/827/large/184ef8f17371abf6d76966f0bc4b9e1e.jpg?1430891533', 'large', 'ben_hoff_1993_2')
//   .then(() => {
//     console.log('success!')
//   })
//   .catch((err) => {
//     console.log(err);
//   })
