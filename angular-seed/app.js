/**
 * Module dependencies.
 */

var express = require('express')
  , auth_proxy = require('./lib/auth_proxy')
  , angular_seed = require('./routes/angular_seed')
  , dust = require('dustjs-linkedin')
  , helpers = require('dustjs-helpers')
  , cons = require('consolidate')
  , path = require('path')
  , nconf = require('nconf')
  , favicon = require('serve-favicon')
  , logger = require('morgan')
  , methodOverride = require('method-override')
  , session = require('express-session')
  , bodyParser = require('body-parser')
  , multer = require('multer')
  , errorHandler = require('errorhandler')
  , passport = require('passport')
  , FacebookStrategy = require('passport-facebook').Strategy
  , RedisStore = require('connect-redis')(session)
  , amqp = require('amqp')
  ;

	var app = express();
	var env = app.get('env');
	
/**
 * Load hierarchical config
 */
	nconf.env().argv();
	if (env)
		nconf.file(env, './config/app-'+env+'.json');
	// The config file 'auth.json' is not provided for security reasons.
	// When you obtain your own Facebook client and secret, create it in config in the following shape:
	//{
	//	"auth": {
	//		"Facebook": {
	//			"client": "-my-app-client-",
	//			"secret": "-my-app-secret-"
	//		}
	//	}
	//}	
	nconf.file('auth', './config/auth.json');
	nconf.file('./config/app.json');	

/**
 * Setting up auth boilerplate
 */

	//Serialize and deserialize the profile
	passport.serializeUser(function(user, done) {
		done(null, user);
	});
	
	passport.deserializeUser(function(obj, done) {
		done(null, obj);
	});
	
	var FacebookAuth = nconf.get('auth').Facebook;
	
	passport.use(new FacebookStrategy({
	    clientID: FacebookAuth.client,
	    clientSecret: FacebookAuth.secret,
	    callbackURL: FacebookAuth.callbackUrl
	  },
	  function(accessToken, refreshToken, profile, done) {
		  profile.token = accessToken;
	      return done(null, profile);
	  }
	));
	
	function ensureAuthenticated(req, res, next) {
	  if (req.isAuthenticated()) { 
	      return next(); 
	  }
	  res.redirect('/angular-seed/auth/facebook');
	}
	
	function preventUnauthenticated(req, res, next) {
	   if (req.isAuthenticated()) {
		   return next();
	   }
	   res.write(JSON.stringify({message: "This endpoint requires full authentication."}));
	   res.send(401);
	   res.end();
	}	
	
/**
 * Redis store options
 */
	var ropts;

	if (process.env.VCAP_SERVICES) {
	    var env = JSON.parse(process.env.VCAP_SERVICES);
	    var credentials = env['redis-2.6'][0].credentials;
	    ropts = {
	    	host: credentials.host,
	    	port: credentials.port,
	    	pass: credentials.password
	    }
	}
	else {
		ropts = {
			host: "localhost",
			port: 6379
		}
	}
	
/**
 * Setting up express
 */
	var sessionConfig = nconf.get('config').session;

	// all environments
	app.set('port', process.env.PORT || nconf.get('port'));
	app.set('views', path.join(__dirname + '/views'));
	app.engine('dust', cons.dust);
	app.set('view engine', 'dust');
	//app.use(favicon(__dirname + '/public/favicon.ico'));
	app.use(methodOverride());
	app.use(bodyParser.json());
	app.use(bodyParser.urlencoded({ extended: true }));
	app.use(multer());
	app.use(express.static(path.join(__dirname, 'public')));
	//app.use(session({ key: sessionConfig.key, 
	//				secret: sessionConfig.secret, saveUninitialized: true, resave: true}));	
	app.use(session({ key: sessionConfig.key, store: new RedisStore(ropts), 
					secret: sessionConfig.secret, saveUninitialized: true, resave: true}));
	app.use(passport.initialize());
	app.use(passport.session());
	
    // development only
	if ('development' == env) {
	  app.use(errorHandler());
	}
	
	// OAuth2 proxy route for the header to use, so that it can make per-user calls
	app.all('/angular-seed/oauth2-proxy', auth_proxy.all);
	
	// Routes
	app.get('/angular-seed/*', angular_seed.get);		
	//app.get('/angular-seed/view1', angular_seed.get);
	//app.get('/angular-seed/view2', angular_seed.get);	

	// Auth routes
	app.get('/angular-seed/auth/facebook', passport.authenticate('facebook', { faulureRedirect: '/', scope: ['public_profile', 'email'] }));
	app.get('/angular-seed/auth/facebook/callback', 
			  passport.authenticate('facebook'),
			  function(req, res) {
		         res.redirect('/angular-seed/');
 	});
	app.get('/logout', function(req, res) {
		req.logout();
		res.redirect(302, FacebookAuth.logoutRedirectUrl);
	});

	//Start the server
	
	var server = app.listen(app.get('port'), function(){
	  console.log('Angular Seed express server '+process.pid+' listening on port ' + app.get('port'));
	});

	var io = require('socket.io')(server);
	
	//Connect to the AMQP broker
	var mq;
	if (process.env.VCAP_SERVICES) {
	    var env = JSON.parse(process.env.VCAP_SERVICES);
	    var credentials = env['rabbitmq-2.8'][0].credentials;
	    mq = amqp.createConnection({ url: credentials.url });
	
	} else {
	   var amqpConfig = nconf.get('config').amqp;
	   mq = amqp.createConnection({ port: amqpConfig.port, host: amqpConfig.host});
	}
	
	mq.on('ready', function() {
		var exchange = mq.exchange('todos');
		//todos.exchange = exchange; 
		mq.queue('angular-seed', function (q) {
			q.bind(exchange, '#');
			q.subscribe(function (message) {
				io.sockets.emit('todos', JSON.parse(message.data));				
			});
		});
	});
	mq.on('error', function(err) {
	    console.log("MQ error from angular-seed: "+err);
	});
	