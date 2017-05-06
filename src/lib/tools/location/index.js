'use strict';

var MILE_OFFSET = 1/62;
let locationService = {};

locationService.getMileOffsets = () => {
  let retObj = {
    publicLatOffset: Math.random() * MILE_OFFSET,
    publicLngOffset: Math.random() * MILE_OFFSET
  };
  let halfDiff = (MILE_OFFSET / 2) - (retObj.publicLatOffset + retObj.publicLngOffset);
  if (halfDiff > 0) {
    if (Math.floor((Math.random() * 2) + 1) > 1) {
      retObj.publicLngOffset += halfDiff;
    } else {
      retObj.publicLatOffset += halfDiff;
    }
  }
  if (Math.floor((Math.random() * 2) + 1) > 1) {
    retObj.publicLngOffset *= -1;
  }
  if (Math.floor((Math.random() * 2) + 1) > 1) {
    retObj.publicLngOffset *= -1;
  }
  return retObj;
}

module.exports = locationService;
