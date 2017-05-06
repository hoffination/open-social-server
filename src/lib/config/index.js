/*jslint node: true */
// Configure server properties in these related files
var cfg = {};
cfg.port = process.env.ENVIRONMENT === 'PROD' ? 80 : 3000;
cfg.env = process.env.ENVIRONMENT === 'PROD' ? 'Production' : 'Development';
cfg.rethinkdb = {
  host: process.env.ENVIRONMENT === 'PROD' ? 'localhost' : 'localhost',
  port: 28015,
}
cfg.secret = process.env.ENVIRONMENT === 'PROD' ? 'secret' : 'secret';
cfg.fbSecret = '';
cfg.fbTokenApi = 'https://graph.facebook.com/oauth/access_token';
cfg.awsAccess = {
  accessKeyId: '',
  secretAccessKey: ""
}
cfg.awsCloudfrontDomain = process.env.ENVIRONMENT === 'PROD' ? 'http://xxx.cloudfront.net/' : 'http://xxx.cloudfront.net/';
cfg.googleApi = '';
cfg.cloudfrontDistributionId = process.env.ENVIRONMENT === 'PROD' ? '' : '';
cfg.awsBucket = process.env.ENVIRONMENT === 'PROD' ? 'image' : 'image-dev';

module.exports = cfg;
