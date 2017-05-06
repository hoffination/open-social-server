let service = {};

service.getClosestCities = (r, longitude, latitude, SEARCH_RANGE, limit) => {
  return r.db('util').table('cities')
    .getNearest(r.point(parseFloat(longitude), parseFloat(latitude)), {index: 'location', maxDist: SEARCH_RANGE, unit: 'mi'})
    .limit(limit || 100)
    .coerceTo('array')
    .run()
}

service.getClosestUniversities = (r, longitude, latitude, SEARCH_RANGE) => {
  return r.db('util').table('universities')
   .getNearest(r.point(parseFloat(longitude), parseFloat(latitude)), {index: 'location', maxDist: SEARCH_RANGE, unit: 'mi'})
   .filter(r.row('doc')('active').eq(true))
   .coerceTo('array')
   .run()
}

service.getClosestRegions = (r, longitude, latitude, SEARCH_RANGE) => {
  return r.db('util').table('regions')
   .getNearest(r.point(parseFloat(longitude), parseFloat(latitude)), {index: 'location', maxDist: SEARCH_RANGE, unit: 'mi'})
   .coerceTo('array')
   .run()
}

module.exports = service;
