﻿#!/usr/bin/env node

var fs = require('fs'),
    path = require('path'),
    url = require('url'),
    downloader = require('./downloader'),
    createConfigParser = require('./createConfigParser'),
    pendingTasks = [],
    Q,
    defaultIconsBaseDir,
    projectRoot,
    config,
    etree;

var logger = {
  log: function () {
    if (process.env.NODE_ENV !== 'test') {
      console.log.apply(this, arguments)
    }
  },
  warn: function() {
    if (process.env.NODE_ENV !== 'test') {
      console.warn.apply(this, arguments)
    }
  },
  error: function() {
    if (process.env.NODE_ENV !== 'test') {
      console.error.apply(this, arguments)
    }
  }
};

function ensurePathExists(pathName, callback) {
  fs.mkdir(pathName, function (err) {
    if (err) {
      if (err.code === 'ENOENT') {
        return ensurePathExists(path.dirname(pathName), function (err) {
          if (err && callback) {
            return callback && callback(err);
          }

          fs.mkdir(pathName, function (err) {
            if (err && err.code === 'EEXIST') { err = undefined; }
            callback && callback(err);
          });
        });
      } else if (err.code === 'EEXIST') {
        err = undefined;
      }
    }

    callback && callback(err);
  });
};

function downloadImage(imageUrl, imagesPath, imageSrc) {
  var deferral = new Q.defer();
  pendingTasks.push(deferral.promise);
  
  ensurePathExists(imagesPath, function(err) {
    if (err && err.code !== 'EEXIST') {
      return logger.error("ERROR: Failed to create directory at: " + imagesPath + ' - ' + err.message);
    }

    downloader.downloadImage(imageUrl, imagesPath, function (err, data) {
        if (err) {
            var localPath = path.join(imagesPath, path.basename(imageSrc));
            if (!fs.existsSync(localPath)) {
              logger.warn('WARNING: Failed to download icon file: ' + imageUrl + ' (' + err.message + ')');
            }
        } else {
          if (data && data.statusCode !== 304) {
            logger.log('Downloaded icon file: ' + data.path);
          }
        }

        deferral.resolve(data);
    });
  });          
}

// normalize icon list and download to res folder
function getManifestIcons(manifest) {
    var iconList = [];
    if (manifest.icons && manifest.icons instanceof Array) {
        manifest.icons.forEach(function (icon) {
            var imageUrl = url.resolve(manifest.start_url, icon.src);
            icon.src = url.parse(imageUrl).pathname;
            var sizes = icon.sizes.toLowerCase().split(' ');
            sizes.forEach(function (iconSize) {
                var dimensions = iconSize.split('x');
                var element = {
                  "src": icon.src,
                  "width": dimensions[0],
                  "height": dimensions[1],
                  "density": icon.density,
                  "type": icon.type
                };

                iconList.push(element);
            });

            var iconsPath = path.dirname(path.join(projectRoot, icon.src));
            
            downloadImage(imageUrl, iconsPath, icon.src);
        });
    }

    return iconList;
}

// Configure Cordova configuration parser
function configureParser(context) {
    var cordova_util = context.requireCordovaModule('cordova-lib/src/cordova/util'),
        ConfigParser = context.requireCordovaModule('cordova-lib/src/configparser/ConfigParser');
    etree = context.requireCordovaModule('cordova-lib/node_modules/elementtree');

    var xml = cordova_util.projectConfig(projectRoot);
    config = createConfigParser(xml, etree, ConfigParser);   
}

function processAccessRules(manifest) {
    if (manifest && manifest.start_url) {
  
        // Remove previous rules
        config.removeElements('.//allow-intent[@hap-rule=\'yes\']');
        config.removeElements('.//allow-navigation[@hap-rule=\'yes\']');
        config.removeElements('.//access[@hap-rule=\'yes\']');
    
        // Remove "full access"" rules
        config.removeElements('.//allow-intent[@href=\'http://*/*\']');
        config.removeElements('.//allow-intent[@href=\'https://*/*\']');
        config.removeElements('.//allow-intent[@href=\'*\']');
        config.removeElements('.//allow-navigation[@href=\'http://*/*\']');
        config.removeElements('.//allow-navigation[@href=\'https://*/*\']');
        config.removeElements('.//allow-navigation[@href=\'*\']');
        config.removeElements('.//access[@origin=\'http://*/*\']');
        config.removeElements('.//access[@origin=\'https://*/*\']');
        config.removeElements('.//access[@origin=\'*\']');
    
        // get the android platform section and create it if it does not exist
        var androidRoot = config.doc.find('platform[@name=\'android\']');
        if (!androidRoot) {
            androidRoot = etree.SubElement(config.doc.getroot(), 'platform');
            androidRoot.set('name', 'android');
        }
    
        // get the ios platform section and create it if it does not exist
        var iosRoot = config.doc.find('platform[@name=\'ios\']');
        if (!iosRoot) {
            iosRoot = etree.SubElement(config.doc.getroot(), 'platform');
            iosRoot.set('name', 'ios');
        }
    
        // determine base rule based on the start_url and the scope
        var baseUrlPattern = manifest.start_url;
        if (manifest.scope && manifest.scope.length) {
            var parsedScopeUrl = url.parse(manifest.scope);
            if (parsedScopeUrl.protocol) {
              baseUrlPattern = manifest.scope;
            } else {
              baseUrlPattern = url.resolve(baseUrlPattern, manifest.scope);
            }
        }
        
        // Add '/*' at the end of the base rule
        if (baseUrlPattern.indexOf('/', baseUrlPattern.length - 1) !== -1) {
          baseUrlPattern = baseUrlPattern.substring(0, baseUrlPattern.length - 1);
        }
        baseUrlPattern = baseUrlPattern + '/*';
        
        // add base rule as an access rule for Android
        var androidAccessBaseRule = new etree.SubElement(androidRoot, 'access');
        androidAccessBaseRule.set('hap-rule','yes');
        androidAccessBaseRule.set('origin', baseUrlPattern);
        
        // add base rule as a navigation rule for Android
        var androidNavigationBaseRule = new etree.SubElement(androidRoot, 'allow-navigation');
        androidNavigationBaseRule.set('hap-rule','yes');
        androidNavigationBaseRule.set('href', baseUrlPattern);
        
        // add base rule as an svvrdd rule for iOS
        var iosBaseAccessRule = new etree.SubElement(iosRoot, 'access');
        iosBaseAccessRule.set('hap-rule','yes');
        iosBaseAccessRule.set('origin', baseUrlPattern);
        
        var baseUrl = baseUrlPattern.substring(0, baseUrlPattern.length - 1);;
    
        // add additional access rules
        if (manifest.mjs_access_whitelist && manifest.mjs_access_whitelist instanceof Array) {
            manifest.mjs_access_whitelist.forEach(function (item) {
                // To avoid duplicates, add the rule only if it does not have the base URL as a prefix
                if (item.url.indexOf(baseUrl) !== 0 ) {
                    // add as an access rule for Android
                    var androidAccessEl = new etree.SubElement(androidRoot, 'access');
                    androidAccessEl.set('hap-rule','yes');
                    androidAccessEl.set('origin', item.url);
    
                    // add as a navigation rule for Android
                    var androidNavigationEl = new etree.SubElement(androidRoot, 'allow-navigation');
                    androidNavigationEl.set('hap-rule','yes');
                    androidNavigationEl.set('href', item.url);  
                    
                    // add as an access rule for iOS
                    var iosAccessEl = new etree.SubElement(iosRoot, 'access');
                    iosAccessEl.set('hap-rule','yes');
                    iosAccessEl.set('origin', item.url);
                }
            });
        }
    }
}

function getFormatFromIcon(icon) {
  return icon.type || (icon.src && icon.src.split('.').pop());
}

function isValidFormat(icon, validFormats) {
  if (!validFormats || validFormats.length === 0) {
    return true;
  }

  var iconFormat = getFormatFromIcon(icon);

  for (var i = 0; i < validFormats.length; i++) {
    if (validFormats[i].toLowerCase() === iconFormat) {
      return true;
    }
  }

  return false;
}

function processIconsBySize(platform, manifestIcons, splashScreenSizes, iconSizes, validFormats) {
    // get platform section and create it if it does not exist
    var root = config.doc.find('platform[@name=\'' + platform + '\']');
    if (!root) {
        root = etree.SubElement(config.doc.getroot(), 'platform');
        root.set('name', platform);
    }

    var platformIcons = root.findall('icon');
    var platformScreens = root.findall('splash');
    manifestIcons.forEach(function (element) {
        if (!isValidFormat(element, validFormats)) {
          return;
        }
        
        // Don't process the icon if the icon file does not exist
        if (!fs.existsSync(path.join(projectRoot, element.src))) {
          return;
        }

        var size = element.width + "x" + element.height;
        if (splashScreenSizes.indexOf(size) >= 0) {
            for (var screen, i = 0; i < platformScreens.length; i++) {
                if (element.width === platformScreens[i].get('width') && element.height === platformScreens[i].get('height')) {
                    screen = platformScreens[i];
                    break;
                }
            }

            if (!screen) {
                screen = etree.SubElement(root, 'splash');
                screen.set('width', element.width);
                screen.set('height', element.height);
            }

            screen.set('src', element.src);
        }
        else if (iconSizes.indexOf(size) >= 0) {
            for (var icon, i = 0; i < platformIcons.length; i++) {
                if (element.width === platformIcons[i].get('width') && element.height === platformIcons[i].get('height')) {
                    icon = platformIcons[i];
                    break;
                }
            }

            if (!icon) {
                icon = etree.SubElement(root, 'icon');
                icon.set('width', element.width);
                icon.set('height', element.height);
            }

            icon.set('src', element.src);
        }
    });
}

function processIconsByDensity(platform, manifestIcons, screenSizeToDensityMap, iconSizeToDensityMap, dppxToDensityMap, validFormats) {
    // get platform section and create it if it does not exist
    var root = config.doc.find('platform[@name=\'' + platform + '\']');
    if (!root) {
        root = etree.SubElement(config.doc.getroot(), 'platform');
        root.set('name', platform);
    }

    var platformIcons = root.findall('icon');
    var platformScreens = root.findall('splash');
    manifestIcons.forEach(function (element) {
        if (!isValidFormat(element, validFormats)) {
            return;
        }
        
        // Don't process the icon if the icon file does not exist
        if (!fs.existsSync(path.join(projectRoot, element.src))) {
            return;
        }

        var size = element.width + "x" + element.height;
        var density = dppxToDensityMap[element.density];
        var isScreen = screenSizeToDensityMap[size];
        if (density && isScreen) {
            density = ((element.width > element.height) ? "land-" : "port-") + density;
        }

        var isIcon = iconSizeToDensityMap[element.width];
        var screenDensity = density || isScreen;
        var iconDensity = density || isIcon;
        if (screenDensity && isScreen) {
            for (var screen, i = 0; i < platformScreens.length; i++) {
                if (screenDensity === platformScreens[i].get('density')) {
                    screen = platformScreens[i];
                    break;
                }
            }

            if (!screen) {
                screen = etree.SubElement(root, 'splash');
                screen.set('density', screenDensity);
            }

            screen.set('src', element.src);
        }
        else if (iconDensity && isIcon) {
            for (var icon, i = 0; i < platformIcons.length; i++) {
                if (iconDensity === platformIcons[i].get('density')) {
                    icon = platformIcons[i];
                    break;
                }
            }

            if (!icon) {
                icon = etree.SubElement(root, 'icon');
                icon.set('density', iconDensity);
            }

            icon.set('src', element.src);
        }
    });
}

function processDefaultIconsByDensity(platform, screenDensities, iconDensities) {   
    // get platform section and create it if it does not exist
    var root = config.doc.find('platform[@name=\'' + platform + '\']');
    if (!root) {
        root = etree.SubElement(config.doc.getroot(), 'platform');
        root.set('name', platform);
    }
    
    var platformIcons = root.findall('icon');
    var platformScreens = root.findall('splash');
    
    iconDensities.forEach(function (iconDensity) {
        for (var icon, i = 0; i < platformIcons.length; i++) {
            if (iconDensity === platformIcons[i].get('density')) {
                icon = platformIcons[i];
                break;
            }
        }
               
        if (!icon) {
            var iconSrc = defaultIconsBaseDir + '/' + platform + '/' + iconDensity + '.png';
            
            icon = etree.SubElement(root, 'icon');
            icon.set('hap-default-image', 'yes');
            icon.set('density', iconDensity);
            icon.set('src', iconSrc);
        }
    });
    
    screenDensities.forEach(function (screenDensity) {
        for (var screen, i = 0; i < platformScreens.length; i++) {
            if (screenDensity === platformScreens[i].get('density')) {
                screen = platformScreens[i];
                break;
            }
        }
        
        if (!screen) {
            var screenSrc = defaultIconsBaseDir + '/' + platform + '/' + screenDensity + '.png';
          
            screen = etree.SubElement(root, 'splash');
            screen.set('hap-default-image', 'yes');
            screen.set('density', screenDensity);
            screen.set('src', screenSrc); 
        }
    });
}

function processDefaultIconsBySize(platform, screenSizes, iconSizes) {   
    // get platform section and create it if it does not exist
    var root = config.doc.find('platform[@name=\'' + platform + '\']');
    if (!root) {
        root = etree.SubElement(config.doc.getroot(), 'platform');
        root.set('name', platform);
    }
    
    var platformIcons = root.findall('icon');
    var platformScreens = root.findall('splash');
    
    iconSizes.forEach(function (iconSize) {
        var dimensions = iconSize.split('x');
        var iconWidth = dimensions[0];
        var iconHeight = dimensions[1];
      
        for (var icon, i = 0; i < platformIcons.length; i++) {
            if (iconWidth === platformIcons[i].get('width') && iconHeight === platformIcons[i].get('height')) {
                icon = platformIcons[i];
                break;
            }
        }
               
        if (!icon) {
            var iconSrc = defaultIconsBaseDir + '/' + platform + '/' + iconSize + '.png';
            
            icon = etree.SubElement(root, 'icon');
            icon.set('hap-default-image', 'yes');            
            icon.set('width', iconWidth);
            icon.set('height', iconHeight);
            icon.set('src', iconSrc);
        }
    });
    
    screenSizes.forEach(function (screenSize) {
        var dimensions = screenSize.split('x');
        var screenWidth = dimensions[0];
        var screenHeight = dimensions[1];
      
        for (var screen, i = 0; i < platformScreens.length; i++) {
            if (screenWidth === platformScreens[i].get('width') && screenHeight === platformScreens[i].get('height')) {
                screen = platformScreens[i];
                break;
            }
        }
        
        if (!screen) {
            var screenSrc = defaultIconsBaseDir + '/' + platform + '/' + screenSize + '.png';
          
            screen = etree.SubElement(root, 'splash');
            screen.set('hap-default-image', 'yes');
            screen.set('width', screenWidth);
            screen.set('height', screenHeight);
            screen.set('src', screenSrc); 
        }
    });
}

function processiOSIcons(manifestIcons) {
    var iconSizes = [
        "40x40",
        "80x80",
        "50x50",
        "100x100",
        "57x57",
        "114x114",
        "60x60",
        "120x120",
        "180x180",
        "72x72",
        "144x144",
        "76x76",
        "152x152",
        "29x29",
        "58x58"
    ];

    var splashScreenSizes = [
        "1024x768",
        "2048x1536",
        "768x1024",
        "1536x2048",
        "640x1136",
        "2208x1242",
        "320x480",
        "640x960",
        "750x1334",
        "1242x2208"
    ];

    processIconsBySize('ios', manifestIcons, splashScreenSizes, iconSizes);
    processDefaultIconsBySize('ios', splashScreenSizes, iconSizes);
}

function processAndroidIcons(manifestIcons, outputConfiguration, previousIndent) {
    var iconSizeToDensityMap = {
        36: 'ldpi',
        48: 'mdpi',
        72: 'hdpi',
        96: 'xhdpi',
        144: 'xxhdpi',
        192: 'xxxhdpi'
    };

    var dppxToDensityMap = {
        0.75:   'ldpi',
        1:      'mdpi',
        1.5:    'hdpi',
        2:      'xhdpi',
        3:      'xxhdpi',
        4:      'xxxhdpi'
    };

    var screenSizeToDensityMap = {
        "800x480": "land-hdpi",
        "320x200": "land-ldpi",
        "480x320": "land-mdpi",
        "1280x720":"land-xhdpi",
        "480x800": "port-hdpi",
        "200x320": "port-ldpi",
        "320x480": "port-mdpi",
        "720x1280":"port-xhdpi"
    };
    
    var iconDensities = [];
    for (var size in iconSizeToDensityMap) {
        if (iconSizeToDensityMap.hasOwnProperty(size)) {
          iconDensities.push(iconSizeToDensityMap[size]);
        }
    }

    var screenDensities = [];
    for (var size in screenSizeToDensityMap) {
        if (screenSizeToDensityMap.hasOwnProperty(size)) {
          screenDensities.push(screenSizeToDensityMap[size]);
        }
    }

    var validFormats = [
      'png',
      'image/png'
    ];
    
    processIconsByDensity('android', manifestIcons, screenSizeToDensityMap, iconSizeToDensityMap, dppxToDensityMap, validFormats);   
    processDefaultIconsByDensity('android', screenDensities, iconDensities);
}

function processWindowsIcons(manifestIcons) {
    var iconSizes = [
        "30x30",
        "44x44",
        "106x106",
        "70x70",
        "71x71",
        "170x170",
        "150x150",
        "360x360",
        "310x310",
        "50x50",
        "120x120",
        "310x150",
        "744x360"
    ];

    var splashScreenSizes = [
        "620x300",
        "1152x1920"
    ];

    processIconsBySize('windows', manifestIcons, splashScreenSizes, iconSizes);
    processDefaultIconsBySize('windows', splashScreenSizes, iconSizes);
};

function processWindowsPhoneIcons(manifestIcons) {
    var iconSizes = [
        "62x62",
        "173x173"
    ];

    var splashScreenSizes = [
        "480x800"
    ];

    processIconsBySize('wp8', manifestIcons, splashScreenSizes, iconSizes);
    processDefaultIconsBySize('wp8', splashScreenSizes, iconSizes);
};

module.exports = function (context) {
    logger.log('Updating Cordova configuration from W3C manifest...');

    Q = context.requireCordovaModule('q');

    // Get base path for default icons
    defaultIconsBaseDir = 'plugins/' + context.opts.plugin.id + '/assets/defaultImages';

    // create a parser for the Cordova configuration
    projectRoot = context.opts.projectRoot;
    configureParser(context);

    // read W3C manifest
    var task = Q.defer();
    
    var manifestPath = path.join(projectRoot, 'manifest.json');
    fs.readFile(manifestPath, function (err, data) {
      if (err) {
        logger.error('Failed to read manifest at \'' + manifestPath + '\'.');
        return task.reject(err);
      }

      var manifestJson = data.toString().replace(/^\uFEFF/, '');
      var appManifestPath = path.join(projectRoot, 'www', 'manifest.json');
      fs.writeFile(appManifestPath, manifestJson, function (err) {
        if (err) {
          logger.error('Failed to copy manifest to \'www\' folder.');
          return task.reject(err);
        }

        var manifest = JSON.parse(manifestJson);

        // The start_url member is required and must be a full URL.
        // Even though a relative URL is a valid according to the W3C spec, a full URL 
        // is needed because the plugin cannot determine the manifest's origin.
        var start_url;
        if (manifest.start_url) {
          start_url = url.parse(manifest.start_url);
        }

        if (!(start_url && start_url.hostname && start_url.protocol)) { 
          logger.error('Invalid or incomplete W3C manifest.');
          var err = new Error('The start_url member in the manifest is required and must be a full URL.');
          return task.reject(err);
        }

        // update name, start_url, orientation, and fullscreen from manifest
        if (manifest.short_name) {
          config.setName(manifest.short_name.replace(/\//g,'').replace(/\s/g,''));
        } else if (manifest.name) {
          config.setName(manifest.name.replace(/\//g,'').replace(/\s/g,''));
        }

        config.setAttribute('content', 'src', manifest.start_url);
        config.setPreference('Orientation', (function(orientation){
          // map W3C manifest orientation options to Cordova orientation options
          switch (orientation){
            case "any":
            case "natural":
            return "default";

            case "landscape":
            case "landscape-primary":
            case "landscape-secondary":
            return "landscape";

            case "portrait":
            case "portrait-primary":
            case "portrait-secondary":
            return "portrait";
          }

        })(manifest.orientation));

        if (manifest.display) {
          config.setPreference('Fullscreen', manifest.display == 'fullscreen' ? 'true' : 'false');
        }

        // configure access rules
        processAccessRules(manifest);

        // Obtain and download the icons specified in the manidest
        var manifestIcons = getManifestIcons(manifest);

        Q.allSettled(pendingTasks).then(function () {
            
          // Configure the icons once all icon files are downloaded
          processiOSIcons(manifestIcons);
          processAndroidIcons(manifestIcons);
          processWindowsIcons(manifestIcons);
          processWindowsPhoneIcons(manifestIcons);
          
          // save the updated configuration
          config.write();
          
          task.resolve();
        });
      });
    });

    return task.promise;
}
