/*jslint node: true */
'use strict';

const async = require('async');
// var winston = rootRequire('log');
const R = require('ramda');

const ONE_HOUR = 3600000;

var heuristicService = {};
heuristicService.ONE_HOUR = ONE_HOUR;

// t < 12 ? (p + c^1.2) + 1 : (p + c^1.2)/(t+2)^1.1
heuristicService.getPostHeuristic = (post) => {
  let dateTodayHours = Date.now() / ONE_HOUR;
  let hoursElapsed = dateTodayHours - (post.tsCreated / ONE_HOUR);
  let numerator = (post.votes + Math.pow(post.comments, 1.2));
  let denominator = Math.pow(hoursElapsed - 11, 1.1);
  return hoursElapsed <= 12 ? numerator + 1 : (numerator + 1) / denominator;
}

/* ((p + c^1.2)/(t+2)^1.1) + (limit/(tDiffHalf^2)) * (-(t - tDiffHalf)^2 + tDiffHalf^2)
*  p = votes, c = comments, t = currentTime, tDiffHalf = time to half way through event
* -------------------------------------------------------------------------------------
*   The halfway through event decision was made to avoid negative values when displaying a
* currently running event. If a user started an event right away, the event would almost
* immmediately become a fully negative value. By having it half way through the event we
* can support events that happen right after the creator posts them.
*/
heuristicService.getEventHeuristic = (eventData) => {
  const LIMIT = 10;
  let dateTodayHours = Date.now() / ONE_HOUR;
  let hoursElapsed = dateTodayHours - (eventData.tsCreated / ONE_HOUR);
  let duration = Math.abs(eventData.endDate/ONE_HOUR - eventData.startDate/ONE_HOUR);
  let hoursDiff = Math.abs(eventData.startDate/ONE_HOUR + duration/2 - eventData.tsCreated/ONE_HOUR);
  let numerator = (eventData.votes + Math.pow(eventData.comments, 1.2));
  let denominator = Math.pow(hoursElapsed + 2, 1.1);
  let baseHeuristic = (numerator + 2) / denominator;
  let modifier = LIMIT / Math.pow(hoursDiff, 2);
  // console.log({
  //   dateTodayHours: dateTodayHours,
  //   hoursElapsed: hoursElapsed,
  //   duration: duration,
  //   hoursDiff: hoursDiff,
  //   baseHeuristic: baseHeuristic,
  //   modifier: modifier
  // })
  return baseHeuristic + modifier * ((-1 * Math.pow((hoursElapsed - hoursDiff), 2)) + Math.pow(hoursDiff, 2));
}

// MAX(% accepted * 2, 1) * (limit/(tDiff^2)) * (-(t - tDiff)^2 + tDiff^2)
heuristicService.getRallyHeuristic = (rallyData) => {
  const LIMIT = 10;
  let dateTodayHours = Date.now() / ONE_HOUR;
  let hoursElapsed = dateTodayHours - (rallyData.tsCreated / ONE_HOUR);
  let hoursDiff = Math.abs(rallyData.startDate/ONE_HOUR - rallyData.tsCreated/ONE_HOUR);
  let modifier = LIMIT / Math.pow(hoursDiff, 2);
  let baseHeuristic = modifier * ((-1 * Math.pow((hoursElapsed - hoursDiff), 2)) + Math.pow(hoursDiff, 2));
  let rallyRequestModifier = !!rallyData.requestCount
    ? ((rallyData.requestCount - rallyData.declinedCount) / rallyData.requestCount) * 2
    : 1;
  return Math.max(1,  rallyRequestModifier) * baseHeuristic;
}

heuristicService.getHeuristic = (postData) => {
  if (postData.type === 'post' || postData.type === 'question') {
    return heuristicService.getPostHeuristic(postData);
  } else if (postData.type === 'event') {
    return heuristicService.getEventHeuristic(postData);
  } else {
    return heuristicService.getRallyHeuristic(postData);
  }
}

heuristicService.applyLocation = (postList, cityId, callback) => {
  async.each(postList, (row, finish) => {
    row.heuristic = row.heuristic * (row.cityId === cityId ? 1.1 : 1);
    delete row.cityId;
    finish();
  }, (err) => {
    if (err) {
      // winston.error('Unable to apply location to content list: ' + JSON.stringify(err), {user: req.body.id, endpoint: 'createEvent', type: errorHandler.NO_CHANGE});
      callback(postList);
    } else {
      callback(postList);
    }
  });
}

heuristicService.getContentPercentages = (counts, limits) => {
  let total = counts.recentPosts + counts.upcomingEvents + counts.upcomingRallies;
  let percentages = {
    posts: {
      value: counts.recentPosts / total,
      atMin: false
    },
    events: {
      value: counts.upcomingEvents / total,
      atMin: false
    },
    rallies: {
      value: counts.upcomingRallies / total,
      atMin: false
    }
  }
  if (percentages.posts.value < limits.post) {
    let diff = (limits.post - percentages.posts.value) / 2;
    percentages.events.value -= diff;
    percentages.rallies.value -= diff;
    percentages.posts.value = limits.post;
    percentages.posts.atMin = true;
  }
  if (percentages.events.value < limits.event) {
    let diff = limits.event - percentages.events.value;
    if (!percentages.posts.atMin) {
      diff /= 2;
      percentages.posts.value -= diff;
    }
    percentages.rallies.value -= diff;
    percentages.events.value = limits.event;
    percentages.events.atMin = true;
  }
  if (percentages.rallies.value < limits.rally) {
    let diff = limits.rally - percentages.rallies.value;
    if (!percentages.events.atMin && !percentages.posts.atMin) {
      diff /= 2;
    }
    if (!percentages.events.atMin) {
      percentages.events.value -= diff;
    }
    if (!percentages.posts.atMin) {
      percentages.posts.value -= diff;
    }
    percentages.rallies.value = limits.rally;
    percentages.rallies.atMin = true;
  }
  return {
    posts: percentages.posts.value,
    events: percentages.events.value,
    rallies: percentages.rallies.value
  };
}

heuristicService.interpolateValues = (results) => {
  var values = R.reduce(getMaxes, {post:{max:0, min:99999},event:{max:0, min:99999},rally:{max:0, min:99999},contactRally:{max:0, min:99999}}, results);
  var absoluteMaxValue = Math.max(values.post.max, values.event.max, values.rally.max);
  var absoluteMinValue = Math.min(values.post.max, values.event.max, values.rally.max);
  var pairedMinValue = 0;
  if (absoluteMaxValue === values.post.max && values.post.min !== values.post.max) {
    pairedMinValue = values.post.min;
  } else if (absoluteMaxValue === values.event.max && values.event.min !== values.event.max) {
    pairedMinValue = values.event.min;
  } else if (absoluteMaxValue === values.rally.max && values.rally.min !== values.rally.max) {
    pairedMinValue = values.rally.min;
  } else {
    pairedMinValue = absoluteMinValue;
  }

  return results.map(content => {
    if (values[content.type].max !== absoluteMaxValue) {
      // content.title += ' - ' + content.heuristic;
      if (values[content.type].max === values[content.type].min) {
        content.heuristic = absoluteMaxValue;
      } else {
        content.heuristic = linearInterpolation(content.heuristic, values[content.type].max, values[content.type].min, absoluteMaxValue, pairedMinValue);
      }
    // } else {
    //   content.title += ' - ' + content.heuristic;
    }
    if (content.type === 'contactRally') {
      content.type = 'rally';
    }
    return content;
  });
}

function linearInterpolation(heuristic, localMax, localMin, totalMax, totalMin) {
  return totalMin + (totalMax - totalMin) * ((heuristic - localMin) / (localMax - localMin));
}

function getMaxes(a, b) {
  if (b.heuristic > a[b.type].max) {
    a[b.type].max = b.heuristic
  }
  if (b.heuristic < a[b.type].min) {
    a[b.type].min = b.heuristic
  }
  return a
}

module.exports = heuristicService;
