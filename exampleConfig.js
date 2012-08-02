/*
 * Required variables
 *
 * username (Google account ID)
 * password (Google account password)
 * source (Google source, like 'com-your-app')
 * port (port to bind to)
 * address (address to bind to)
 * debugServerPort (port to bind for stats / debug server)
 * debugServeraddress (address to bind for stats / debug server)
 * serverCallbackHost / serverCallbackPort / serverCallbackPath / serverCallbackSharedSecret /
 * serverCallbackProtocol
 * (if specified, will be used to send a POST back to a service in order to handle bad tokens)
 *
 */
 
  var config = {}
  config.port =  8120;
  config.address= "127.0.0.1";
  config.apiKey = '';
  config.syslog = false;
  module.exports = config;

