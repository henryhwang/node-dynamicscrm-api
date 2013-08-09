// module dependencies
var https       = require('https');
var url         = require('url');
var xpath       = require('xpath');
var cookie      = require('cookie');
var Cache       = require("mem-cache");
var uuid        = require("node-uuid");
var domParser   = new (require('xmldom').DOMParser)();
var path        = require("path");
var urljs       = require("url");
var uuid        = require("node-uuid");
var fs          = require("fs");
var parser      = require('xml2json');
var xslt        = require('node_xslt');

var Serializer   = require('./serializer.js');

// this class implements all features 
var Util = function (settings) {

    // Arguments validation
    if (!settings || typeof(settings)!=="object") throw new Error("'settings' argument must be an object instance.");
    if (!settings.organizationid || typeof(settings.organizationid)!=="string") throw new Error("'settings.organizationid' property is a required string.");
    if (!settings.domain || typeof(settings.domain)!=="string") throw new Error("'settings.domain' property is a required string.");
    if (settings.timeout!==undefined && typeof(settings.timeout)!=="number") throw new Error("'settings.timeout' property must be a number.");
    if (settings.username && typeof(settings.username)!=="string") throw new Error("'settings.username' property must be a string.");
    if (settings.password && typeof(settings.password)!=="string") throw new Error("'settings.password' property must be a string.");

    // Sets default arguments values
    settings.timeout = settings.timeout || 15 * 60 * 1000;  // default sessions timeout of 15 minutes in ms   
    settings.returnJson = true;                             // default sessions timeout of 15 minutes in ms   
    settings.discoveryServiceAddress = settings.discoveryServiceAddress || "https://dev.crm.dynamics.com/XRMServices/2011/Discovery.svc";

    var self            = this;     // Auto reference
    var entitySets      = null;     // String array containing all entity sets names
    var pendingHook     = null;     // Function that will be executed after 'entitySets' array was populated.
    
    var organizationServiceEndpoint = 'https://' + settings.domain + '.api.crm.dynamics.com/XRMServices/2011/Organization.svc';

    // Cache by authentication token, containing all session instances
    Object.defineProperty(this, "cacheAuth", {
        enumerable: false,
        configurable: false,
        writable: false,
        value: new Cache(settings.timeout)
    });

    // cache by user name, containing all authentication tokens
    var usersCache   = new Cache(settings.timeout);   // Cache by auth tokens 
    var tokensForDeviceCache   = new Cache(settings.timeout);   

    //
    var endpoints  = null;
    var device  = null;


    //load templates once
    var authCreateDeviceMessage = fs.readFileSync("../lib/templates/auth_create_device.xml").toString();
    var authRequestDeviceTokenMessage = fs.readFileSync("../lib/templates/auth_tokenrequest_device.xml").toString();
    var authRequestSTSTokenMessage = fs.readFileSync("../lib/templates/auth_tokenrequest_liveid.xml").toString();
    
    var soapEnvelopeMessage = fs.readFileSync("../lib/templates/soapMessage.xml").toString();
    var soapHeaderMessage = fs.readFileSync("../lib/templates/soapHeader.xml").toString();

    var apiRetrieveMultipleMessage = fs.readFileSync("../lib/templates/api_retrievemultiple.xml").toString();
    var apiRetrieveMessage = fs.readFileSync("../lib/templates/api_retrieve.xml").toString();
    var apiCreateMessage = fs.readFileSync("../lib/templates/api_create.xml").toString();
    var apiUpdateMessage = fs.readFileSync("../lib/templates/api_update.xml").toString();
    var apiDeleteMessage = fs.readFileSync("../lib/templates/api_delete.xml").toString();
    var apiExecuteMessage = fs.readFileSync("../lib/templates/api_execute.xml").toString();
    var apiAssociateMessage = fs.readFileSync("../lib/templates/api_asociate.xml").toString();
    var apiDisassociateMessage = fs.readFileSync("../lib/templates/api_disassociate.xml").toString();

    var stylesheet = xslt.readXsltFile("../lib/templates/remove_ns.xslt");

    serializer = new Serializer();

    this.Authenticate = function(options, cb) {

         // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};

        // validates arguments values
        if (typeof options !== 'object') return cb(new Error("'options' argument is missing or invalid."));


        // Validates username and password 
        options.username = options.username || settings.username;
        options.password = options.password || settings.password;

        var auth = usersCache.get(options.username);
        if (auth) {
            var item = self.cacheAuth.get(auth);
            return cb(null, item);
        }


        var authOptions = options;
        fetchEndpoints(function(err, result)
        {
            authOptions = result;
            authOptions.username = options.username;
            authOptions.password = options.password;
            loadOrRegisterDevice(authOptions, function(err, result)
                {
                    authOptions.DeviceInfo = result;
                    getTokenUsingDeviceId(authOptions, function(err, result)
                        {
                            var timeCreated = new Date();
                            var timeExpires = new Date(timeCreated.getTime() + settings.timeout);

                            authOptions.cipherValue = result.CipherValue;
                            authRequestSTSTokenMessage = authRequestSTSTokenMessage.replace("{messageuuid}", uuid.v4()).replace("{created}", timeCreated.toISOString()).replace("{expires}", timeExpires.toISOString())
                                .replace("{issuer}", authOptions.IssuerAddress)
                                .replace("{cipher}", authOptions.cipherValue)
                                .replace("{username}", authOptions.username)
                                .replace("{password}", authOptions.password);        


                            var requestOptions = {
                                method: 'POST',
                                host: urljs.parse(authOptions.IssuerAddress).host,
                                path: urljs.parse(authOptions.IssuerAddress).pathname,
                                headers: {
                                    'Content-Type': 'application/soap+xml; charset=UTF-8'
                                    ,'Content-Length': authRequestSTSTokenMessage.length
                                }
                            }; 

                            var req = https.request(requestOptions, function (res) {
                                var xml = '';
                                res.setEncoding('utf8');
                                res.on('data', function (chunk) { xml += chunk; })
                                res.on('end', function () {
                                    var resXml = domParser.parseFromString(xml); 

                                    onSoapFaultAbort(resXml, cb);

                                    var keyIdentifier = xpath.select("//*[local-name()='RequestedSecurityToken' and namespace-uri()='http://schemas.xmlsoap.org/ws/2005/02/trust']/*[name()='EncryptedData']/*[local-name()='KeyInfo' and namespace-uri()='http://www.w3.org/2000/09/xmldsig#']/*[name()='EncryptedKey']/*[local-name()='KeyInfo']/*[local-name()='SecurityTokenReference']/*[local-name()='KeyIdentifier']/text()", resXml).toString();
                                    var cipherValue0 = xpath.select("//*[local-name()='RequestedSecurityToken' and namespace-uri()='http://schemas.xmlsoap.org/ws/2005/02/trust']/*[name()='EncryptedData']/*[local-name()='KeyInfo' and namespace-uri()='http://www.w3.org/2000/09/xmldsig#']/*[name()='EncryptedKey']/*[local-name()='CipherData']/*[local-name()='CipherValue']/text()", resXml).toString();
                                    var cipherValue1 = xpath.select("//*[local-name()='RequestedSecurityToken' and namespace-uri()='http://schemas.xmlsoap.org/ws/2005/02/trust']/*[name()='EncryptedData']/*[name()='CipherData']/*[name()='CipherValue']/text()", resXml).toString();

                                    var userTokens = {
                                            KeyIdentifier : keyIdentifier,
                                            CiperValue0 : cipherValue0,
                                            CiperValue1 : cipherValue1
                                    };

                                    usersCache.set(options.username,userTokens);
                                    return cb(null, userTokens);
                                })
                            });

                            req.end(authRequestSTSTokenMessage); 
                        });
                });
        });
    }

    var fetchEndpoints = function (cb) {

        if (endpoints) {
            return cb(null, endpoints);   
        };

        var options = {
            host: settings.domain + '.api.crm.dynamics.com',
            path: '/XRMServices/2011/Discovery.svc?wsdl'
        };

        var response = https.get (options, function(res) {
            var xml = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) { xml += chunk; })
            res.on('end', function () {
                var resXml = domParser.parseFromString(xml); 
                
                onSoapFaultAbort(resXml, cb);

                var location = xpath.select("//*[local-name()='import' and namespace-uri()='http://schemas.xmlsoap.org/wsdl/']/@location", resXml).map(function(attr) 
                    { return attr.value;})[0];

                if (location.length > 0) {
                    var opts = {
                        host: urljs.parse(location).host,
                        path: urljs.parse(location).pathname + urljs.parse(location).search
                    };    

                    var response = https.get (opts, function(res) {
                        var xml = '';
                        res.setEncoding('utf8');
                        res.on('data', function (chunk) { xml += chunk; })
                        res.on('end', function () {
                            var resXml = domParser.parseFromString(xml); 
                            
                            onSoapFaultAbort(resXml, cb);

                            var authenticationType = xpath.select("//*[local-name()='Authentication' and namespace-uri()='http://schemas.microsoft.com/xrm/2011/Contracts/Services']/text()", resXml).toString();
                            var issuerAddress = xpath.select("//*[local-name()='SignedSupportingTokens']/*[local-name()='Policy']/*[local-name()='IssuedToken']/*[local-name()='Issuer']/*[local-name()='Address']/text()", resXml).toString();
                            var liveAppliesTo = xpath.select("//*[local-name()='LiveIdAppliesTo']/text()", resXml).toString();

                            if (authenticationType==="LiveId") {
                                endpoints = {
                                    AuthenticationType : authenticationType,
                                    IssuerAddress : issuerAddress, 
                                    DeviceAddUrl : "https://login.live.com/ppsecure/DeviceAddCredential.srf",
                                    LiveIdAppliesTo : liveAppliesTo
                                };
                                return cb(null, endpoints);   
                            }
                            
                            throw new Error("'This version only implements 'LiveId' authentication type");
                            
                        });
                    });
                }  
            });
        });
    }


    var loadOrRegisterDevice = function (options, cb) {
        
        if(device)
        {
            return cb(null, device); 
        }
        
        var username = generateRandom(24,'aA#');
        var password = generateRandom(24,'aA#');

        authCreateDeviceMessage = authCreateDeviceMessage
            .replace("{newguid}", uuid.v4())
            .replace("{username}", username)
            .replace("{password}", password)
        ;

        var options = {
            method: 'POST',
            host: urljs.parse(options.DeviceAddUrl).host,
            path: urljs.parse(options.DeviceAddUrl).pathname,
            headers: {
                'Content-Type': 'application/soap+xml; charset=UTF-8',
                'Content-Length': authCreateDeviceMessage.length
            }
        }; 

        var req = https.request(options, function (res) {
            var xml = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) { xml += chunk; })
            res.on('end', function () {
                var resXml = domParser.parseFromString(xml); 
                onSoapFaultAbort(resXml, cb);

                var puid = xpath.select("/DeviceAddResponse/puid/text()", resXml).toString();

                device = {
                    deviceUsername : username,
                    devicePassword : password,
                    puid : puid
                };

                return cb(null, device); 

            })
        });

        req.end(authCreateDeviceMessage);
    }


    var getTokenUsingDeviceId = function(options, cb) {
        var timeCreated = new Date();
        var timeExpires = new Date(timeCreated.getTime() + settings.timeout);

        var cipher = tokensForDeviceCache.get("auth_tokenrequest_device");
        if (cipher) {
            return cb(null, cipher);
        };

        authRequestDeviceTokenMessage = authRequestDeviceTokenMessage
            .replace("{messageuuid}", uuid.v4())
            .replace("{timeCreated}", timeCreated.toISOString())
            .replace("{timeExpires}", timeExpires.toISOString())
            .replace("{issuer}", options.IssuerAddress)
            .replace("{liveIdAppliesTo}", options.LiveIdAppliesTo)
            .replace("{deviceUsername}", options.DeviceInfo.deviceUsername)
            .replace("{devicePassword}", options.DeviceInfo.devicePassword)
        ;

        var requestOptions = {
            method: 'POST',
            host: urljs.parse(options.IssuerAddress).host,
            path: urljs.parse(options.IssuerAddress).pathname,
            headers: {
                'Content-Type': 'application/soap+xml; charset=UTF-8'
                ,'Content-Length': authRequestDeviceTokenMessage.length
            }
        }; 
        var req = https.request(requestOptions, function (res) {
            var xml = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) { xml += chunk; })
            res.on('end', function () {
                var resXml = domParser.parseFromString(xml); 

                onSoapFaultAbort(resXml, cb);

                var cipherValue = xpath.select("//*[local-name()='RequestedSecurityToken' and namespace-uri()='http://schemas.xmlsoap.org/ws/2005/02/trust']/*[name()='EncryptedData']/*[name()='CipherData']/*[name()='CipherValue']/text()", resXml).toString();
                cipher = {CipherValue : cipherValue};
                
                tokensForDeviceCache.set("auth_tokenrequest_device", cipher);

                return cb(null, cipher);   
            })
        });

        req.end(authRequestDeviceTokenMessage);
    }

    var generateRandom = function (length, chars) {
        var mask = '';
        if (chars.indexOf('a') > -1) mask += 'abcdefghijklmnopqrstuvwxyz';
        if (chars.indexOf('A') > -1) mask += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (chars.indexOf('#') > -1) mask += '0123456789';
        if (chars.indexOf('!') > -1) mask += '~`!@#$%^&*()_+-={}[]:";\'<>?,./|\\';
        var result = '';
        for (var i = length; i > 0; --i) result += mask[Math.round(Math.random() * (mask.length - 1))];
        return result;
    }


    var onSoapFaultAbort = function (resXml, cb)
    {
        var fault = xpath.select("//*[local-name()='Fault']/*[local-name()='Reason']/*[local-name()='Text']/text()", resXml);
        if (fault.length > 0) return cb(new Error(fault.toString()));
    }

    // adds methods dinamically to the instance passed by parameter.
    // for each entity set, methods for get, update, create, etc. will be added.
    this.hook = function(target) {

        // function for add a single method
        var addMethod = function(method, prefix, entitySet) {

            target[prefix + entitySet] = function (options, cb) {

                if (!cb && typeof options === 'function') {
                    cb = options;
                    options = {};
                }
                
                cb = cb || defaultCb;
                options = options || {};
                options.resource = entitySet;

                method(options, cb);
            };
        };
    };

    /*
    RetrieveMultiple public and private methods
    */
    this.RetrieveMultiple = function(options, cb)
    {
        // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};
        if (!options || typeof options !== 'object')    return cb(new Error("'options' argument is missing or invalid."));

        if (options.KeyIdentifier && options.CiperValue0 && options.CiperValue1) {
            executeSoapPost(options, "RetrieveMultiple", apiRetrieveMultipleMessage, serializer.toXmlRetrieveMultiple(options), cb);
        } 
        else {
            this.Authenticate(options, function(err, result) {
                if (err) return cb(new Error("Couldn't execute RetrieveMultiple. " + err));
                options.KeyIdentifier = result.KeyIdentifier;
                options.CiperValue0 = result.CiperValue0;
                options.CiperValue1 = result.CiperValue1;

                executeSoapPost(options, "RetrieveMultiple", apiRetrieveMultipleMessage, serializer.toXmlRetrieveMultiple(options), cb);
            });
        }
    };


    /*
    Retrieve  public and private methods
    */
    this.Retrieve = function(options, cb)
    {
        // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};
        if (!options || typeof options !== 'object')    return cb(new Error("'options' argument is missing or invalid."));

        if (options.KeyIdentifier && options.CiperValue0 && options.CiperValue1) {
            executeSoapPost(options, "Retrieve", apiRetrieveMessage, serializer.toXmlRetrieve(options), cb);
        } 
        else {
            this.Authenticate(options, function(err, result) {
                if (err) return cb(new Error("Couldn't execute Retrieve. " + err));
                options.KeyIdentifier = result.KeyIdentifier;
                options.CiperValue0 = result.CiperValue0;
                options.CiperValue1 = result.CiperValue1;

                executeSoapPost(options, "Retrieve", apiRetrieveMessage, serializer.toXmlRetrieve(options), cb);
            });
        }
    };

    /*
    Create  public and private methods
    */
    this.Create = function(options, cb)
    {
        // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};
        if (!options || typeof options !== 'object')    return cb(new Error("'options' argument is missing or invalid."));

        if (options.id || options.Id)    return cb(new Error("'options.id' argument is not allowed."));

        if (options.KeyIdentifier && options.CiperValue0 && options.CiperValue1) {

            executeSoapPost(options, "Create", apiCreateMessage, serializer.toXmlCreateUpdate(options), cb);

        } 
        else {
            this.Authenticate(options, function(err, result) {

                if (err) return cb(new Error("Couldn't execute Create. " + err));
                options.KeyIdentifier = result.KeyIdentifier;
                options.CiperValue0 = result.CiperValue0;
                options.CiperValue1 = result.CiperValue1;
                
                executeSoapPost(options, "Create", apiCreateMessage, serializer.toXmlCreateUpdate(options), cb);
            });
        }
    };

    /*
    Update  public and private methods
    */
    this.Update = function(options, cb)
    {
        // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};
        if (!options || typeof options !== 'object')    return cb(new Error("'options' argument is missing or invalid."));

        if (options.KeyIdentifier && options.CiperValue0 && options.CiperValue1) {
            executeSoapPost(options, "Update", apiUpdateMessage, serializer.toXmlCreateUpdate(options), cb);
        } 
        else {
            this.Authenticate(options, function(err, result) {
                if (err) return cb(new Error("Couldn't execute Update. " + err));
                options.KeyIdentifier = result.KeyIdentifier;
                options.CiperValue0 = result.CiperValue0;
                options.CiperValue1 = result.CiperValue1;

                executeSoapPost(options, "Update", apiUpdateMessage, serializer.toXmlCreateUpdate(options), cb);
            });
        }
    };    
    /*
    Update  public and private methods
    */
    this.Delete = function(options, cb)
    {
        // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};
        if (!options || typeof options !== 'object')    return cb(new Error("'options' argument is missing or invalid."));

        if (options.KeyIdentifier && options.CiperValue0 && options.CiperValue1) {
            executeSoapPost(options, "Delete", apiDeleteMessage, serializer.toXmlDelete(options), cb);
        } 
        else {
            this.Authenticate(options, function(err, result) {
                if (err) return cb(new Error("Couldn't execute Update. " + err));
                options.KeyIdentifier = result.KeyIdentifier;
                options.CiperValue0 = result.CiperValue0;
                options.CiperValue1 = result.CiperValue1;

                executeSoapPost(options, "Delete", apiDeleteMessage, serializer.toXmlDelete(options), cb);
            });
        }
    };    
    /*
    Execute  public and private methods
    */
    this.Execute = function(options, cb)
    {
        // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};
        if (!options || typeof options !== 'object')    return cb(new Error("'options' argument is missing or invalid."));

        if (options.KeyIdentifier && options.CiperValue0 && options.CiperValue1) {
            executeSoapPost(options, "Execute", apiExecuteMessage, serializer.toXmlExecute(options), cb);
        } 
        else {
            this.Authenticate(options, function(err, result) {
                if (err) return cb(new Error("Couldn't execute Update. " + err));
                options.KeyIdentifier = result.KeyIdentifier;
                options.CiperValue0 = result.CiperValue0;
                options.CiperValue1 = result.CiperValue1;

                executeSoapPost(options, "Execute", apiExecuteMessage, serializer.toXmlExecute(options), cb);
            });
        }
    };    
    /*
    Associate  public and private methods
    */
    this.Associate = function(options, cb)
    {
        // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};
        if (!options || typeof options !== 'object')    return cb(new Error("'options' argument is missing or invalid."));

        if (options.KeyIdentifier && options.CiperValue0 && options.CiperValue1) {
            executeSoapPost(options, "Associate", apiAssociateMessage, serializer.toXmlAssociate(options), cb);
        } 
        else {
            this.Authenticate(options, function(err, result) {
                if (err) return cb(new Error("Couldn't execute Update. " + err));
                options.KeyIdentifier = result.KeyIdentifier;
                options.CiperValue0 = result.CiperValue0;
                options.CiperValue1 = result.CiperValue1;

                executeSoapPost(options, "Associate", apiAssociateMessage, serializer.toXmlAssociate(options), cb);
            });
        }
    };    

    this.Disassociate = function(options, cb)
    {
        // handles optional 'options' argument
        if (!cb && typeof options === 'function') {
            cb = options;
            options = {};
        }

        // sets default values
        cb = cb || defaultCb;
        options = options || {};
        if (!options || typeof options !== 'object')    return cb(new Error("'options' argument is missing or invalid."));

        if (options.KeyIdentifier && options.CiperValue0 && options.CiperValue1) {
            executeSoapPost(options, "Disassociate", apiDisassociateMessage, serializer.toXmlAssociate(options), cb);
        } 
        else {
            this.Authenticate(options, function(err, result) {
                if (err) return cb(new Error("Couldn't execute Update. " + err));
                options.KeyIdentifier = result.KeyIdentifier;
                options.CiperValue0 = result.CiperValue0;
                options.CiperValue1 = result.CiperValue1;

                executeSoapPost(options, "Disassociate", apiDisassociateMessage, serializer.toXmlAssociate(options), cb);
            });
        }
    };    


    var executeSoapPost = function(options, action, template, body, cb)
    {
        var timeCreated = new Date();
        var timeExpires = new Date(timeCreated.getTime() + 5*60000);

        soapHeaderMessage = soapHeaderMessage
            .replace("{action}", action) 
            .replace("{messageid}", uuid.v4())
            .replace("{crmurl}", organizationServiceEndpoint)
            .replace("{created}", timeCreated.toISOString())
            .replace("{expires}", timeExpires.toISOString())
            .replace("{keyidentifier}", options.KeyIdentifier)
            .replace("{cipher0}", options.CiperValue0)
            .replace("{cipher1}", options.CiperValue1)
        ;

        var xmlrequestbody = template.replace("{requetbody}", body);

        soapEnvelopeMessage = soapEnvelopeMessage
            .replace("{header}", soapHeaderMessage)
            .replace("{body}", xmlrequestbody)
        ;

        var requestOptions = {
            method: 'POST',
            host: settings.domain + '.api.crm.dynamics.com',
            path: '/XRMServices/2011/Organization.svc' ,
            headers: {
                'Content-Type': 'application/soap+xml; charset=UTF-8'
                ,'Content-Length': soapEnvelopeMessage.length
            }
        }; 
        var req = https.request(requestOptions, function (res) {
            var xml = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) { xml += chunk; })
            res.on('end', function () {
                onSoapFaultAbort(domParser.parseFromString(xml), cb);
                //var data =  (settings.returnJson ? parser.toJson(xml) : xml );
                var data = xml;

                if (settings.returnJson) {
                    var xmldoc = xslt.readXmlString(xml);
                    var data = parser.toJson(xslt.transform(stylesheet, xmldoc, ['param1Name', 'param1Value']));
                };

                cb(null, data );
            })
        });

        req.end(soapEnvelopeMessage);  
    }

};

module.exports = Util;