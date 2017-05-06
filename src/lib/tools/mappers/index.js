/*jslint node: true */
'use strict';

var mapper = {};

mapper.mapRallyData = (rallyData, id, contactIds) => {
  rallyData.confirmedCount = rallyData.confirmedUsers.length;
  rallyData.isConfirmed = (rallyData.confirmedUsers.indexOf(id) !== -1);
  delete rallyData.confirmedUsers;
  rallyData.isMember = (rallyData.members.indexOf(id) !== -1);
  delete rallyData.members;
  rallyData.isRequested = (rallyData.requests.indexOf(id) !== -1);
  delete rallyData.requests;
  rallyData.isInvited = rallyData.isPending;
  delete rallyData.isPending;
  if (rallyData.isConfirmed || rallyData.isMember || rallyData.isInvited || rallyData.privacy === 'protected') {
    if (rallyData.location) {
      delete rallyData.location;
    }
    if (rallyData.publicLocation) {
      delete rallyData.publicLocation;
    }
  } else if (contactIds && contactIds.indexOf(rallyData.creator) !== -1) {
    delete rallyData.comments;
    delete rallyData.privateLocation;
  } else {
    delete rallyData.comments;
    delete rallyData.privateLocation;
    if (rallyData.creator) {
      delete rallyData.creator;
    }
    rallyData.photoId = '';
    delete rallyData.creatorName;
    delete rallyData.creatorFullName;
  }
  return rallyData;
}

mapper.mapAllyRallies = (rallyData, id) => {
  if (!rallyData) {
    return rallyData;
  }
  rallyData.confirmedCount = rallyData.confirmedUsers.length;
  rallyData.isConfirmed = (rallyData.confirmedUsers.indexOf(id) !== -1);
  delete rallyData.confirmedUsers;
  rallyData.isMember = (rallyData.members.indexOf(id) !== -1);
  delete rallyData.members;
  rallyData.isRequested = (rallyData.requests.indexOf(id) !== -1);
  delete rallyData.requests;
  rallyData.isInvited = rallyData.isPending;
  delete rallyData.isPending;
  if (rallyData.location) {
    delete rallyData.location;
  }
  if (rallyData.publicLocation) {
    delete rallyData.publicLocation;
  }
  return rallyData;
}

mapper.mapRallyContentView = (rallyData, id, isContact) => {
  delete rallyData.cityId;
  rallyData.isConfirmed = rallyData.confirmedUsers.indexOf(id) !== -1;
  rallyData.isMember = rallyData.members.indexOf(id) !== -1;
  rallyData.isRequested = rallyData.requests.indexOf(id) !== -1

  if (rallyData.isConfirmed || rallyData.isMember || rallyData.isInvited || rallyData.privacy === 'protected') {
    if (rallyData.location) {
      delete rallyData.location;
    }
    if (rallyData.publicLocation) {
      delete rallyData.publicLocation;
    }
    if (rallyData.creator !== id) {
      delete rallyData.declined;
      delete rallyData.requests;
    }
  } else if (isContact) {
    delete rallyData.address;
    rallyData.confirmedCount = rallyData.confirmedUsers.length;
    delete rallyData.confirmedUsers;
    delete rallyData.members;
    delete rallyData.privateLocation;
    delete rallyData.requests;
  } else {
    delete rallyData.address;
    rallyData.confirmedCount = rallyData.confirmedUsers.length;
    delete rallyData.confirmedUsers;
    delete rallyData.creator;
    delete rallyData.creatorName;
    delete rallyData.creatorFullName;
    rallyData.photoId = '';
    delete rallyData.members;
    delete rallyData.privateLocation;
    delete rallyData.requests;
  }
  return rallyData;
}

module.exports = mapper;
