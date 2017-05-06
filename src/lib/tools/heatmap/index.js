'use strict';

const moment = require('moment');
let heatmapService = {};

heatmapService.getFifteenMinuteBreakdown = (contentArray, attributeStartName, attributeEndName) => {
  let heatmap = {'Sunday':{}, 'Monday':{}, 'Tuesday':{}, 'Wednesday':{}, 'Thursday':{}, 'Friday':{}, 'Saturday':{}};
  contentArray.map(content => {
    let currentDate = moment(content[attributeStartName]);

    while (currentDate.valueOf() <= content[attributeEndName]) {
      let day = currentDate.format('dddd');
      let hours = currentDate.hour();
      let minutes = currentDate.minute();

      if (minutes < 15) {
        minutes = 0;
      } else if (minutes < 30) {
        minutes = 15;
      } else if (minutes < 45) {
        minutes = 30;
      } else {
        minutes = 45;
      }

      if (!heatmap[day]) {
        heatmap[day] = {};
      }
      if (!heatmap[day][hours]) {
        heatmap[day][hours] = {};
      }
      if (!heatmap[day][hours][minutes]) {
        heatmap[day][hours][minutes] = 1;
      } else {
        heatmap[day][hours][minutes]++;
      }

      currentDate.add(15, 'm');
    }
  });
  return heatmap;
}

module.exports = heatmapService;
