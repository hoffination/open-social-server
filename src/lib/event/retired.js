// Old get map content request to respect regions
router.post('/getMapContentByTime', function(req, res) {
  auth.checkAuthAndId(req, res, req.body.id, function(err) {
    if (err) {
      return errorHandler.handleErrorMessage(res, err, errorHandler.AUTH);
    } else if (!req.body.id) {
      return errorHandler.handleErrorMessage(res, 'Missing user id', errorHandler.BAD_INPUT);
    } else if (!req.body.startDate || !req.body.endDate) {
      return errorHandler.handleErrorMessage(res, 'Missing datetime information', errorHandler.BAD_INPUT);
    } else if (!req.body.cityId) {
      return errorHandler.handleErrorMessage(res, 'Missing city ID', errorHandler.BAD_INPUT);
    } else {
      var retObject = {};
      r.db('util').table('regions')
        .getAll(req.body.cityId, {index: 'cityId'})
        .innerJoin(r.db('util').table('regions'), function(city, region) {
          return city('regionName').eq(region('regionName'));
        })('right')('cityId')
        .coerceTo('array')
        .run()
        .then(function getEvents(regions) {
          return r
            .db('forum').table('content')
            .getAll('event', {index: 'type'})
            .filter(r.row('startDate').le(parseInt(req.body.endDate)).and(r.row('endDate').ge(parseInt(req.body.startDate))))
            .filter(function(content) {
              if (regions.length > 0)
                return r.expr(regions).contains(content('cityId'));
              else if (req.body.cityId === -1)
                return true;
              else
                return content('cityId').eq(req.body.cityId);
            })
            .pluck('id', 'category', 'startDate', 'endDate', 'location', 'title', 'generalArea', 'comments')
            .coerceTo('array')
            .run();
        })
        .....
