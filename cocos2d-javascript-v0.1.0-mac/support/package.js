#!/usr/bin/env node

/**
 * @fileOverview Generates a Windows installer .exe and a .zip
 */

var sys = require('sys'),
    fs  = require('fs'),
    path = require('path'),
    spawn = require('child_process').spawn;

// Include cocos2d because it has some useful modules
require.paths.unshift(path.join(__dirname, '../lib'));

var Template = require('cocos2d/Template').Template;

var VERSION = JSON.parse(fs.readFileSync(__dirname + '/../package.json')).version;

sys.puts('Packaging Cocos2D JavaScript version ' + VERSION);

function mkdir(dir, mode) {
    mode = mode || 511; // Octal = 0777;
    
    if (dir[0] != '/') {
        dir = path.join(process.cwd(), dir);
    }

    var paths = [dir];
    var d = dir;
    while ((d = path.dirname(d)) && d != '/') {
        paths.unshift(d);
    }

    for (var i = 0, len = paths.length; i < len; i++) {
        var p = paths[i];
        if (!path.existsSync(p)) {
            fs.mkdirSync(p, mode);
        }
    }
}

/**
 * Generates an NSIS installer script to install the contents of a given
 * directory and returns it as a string.
 *
 * @param {String} dir The directory that will be installed
 * @returns String The contents of the NSIS script
 */
function generateNSISScript(files, callback) {
    sys.puts('Generating NSIS script');
    var installFileList = '  SetOverwrite try\n',
        removeFileList  = '',
        removeDirList   = '';

    files = files.filter(function(file) {
        // Ignore node-builds for other platforms
        if (~file.indexOf('node-builds') && !~file.indexOf('win') && !~file.indexOf('tmp') && !~file.indexOf('etc')) {
            return;
        }

        return file;
    });


    // Generate the install and remove lists
    var prevDirname, i, len;
    for (i = 0, len = files.length; i < len; i++) {
        var file = files[i];
        var dirname = path.dirname(file);

        if (dirname != prevDirname) {
            prevDirname = dirname;
            installFileList += '  SetOutPath "$INSTDIR\\' + dirname.replace(/\//g, '\\') + '"\n';
            removeDirList  += '  RMDir "$INSTDIR\\' + dirname.replace(/\//g, '\\') + '"\n';
        }

        var m;
        if ((m = file.match(/\/?(README|LICENSE)(.md)?$/))) {
            // Rename README and LICENSE so they end in .txt
            installFileList += '  File /oname=' + m[1] + '.txt "${ROOT_PATH}\\' + file.replace(/\//g, '\\') + '"\n';
        } else {
            installFileList += '  File "${ROOT_PATH}\\' + file.replace(/\//g, '\\') + '"\n';
        }
        removeFileList  += '  Delete "$INSTDIR\\' + file.replace(/\//g, '\\') + '"\n';
    }


    var tmp = new Template(fs.readFileSync(path.join(__dirname, 'installer_nsi.template'), 'utf8'));
    var data = tmp.substitute({
        root_path: '..',
        version: 'v' + VERSION,
        install_file_list: installFileList,
        remove_file_list: removeFileList,
        remove_dir_list: removeDirList
    });

    callback(data);
}

/**
 * Uses git to find the files we want to install. If a file isn't commited,
 * then it won't be installed.
 *
 * @param {String} dir The directory that will be installed
 * @returns String[] Array of file paths
 */
function findFilesToPackage(dir, callback) {
    var cwd = process.cwd();
    process.chdir(dir);

    var gitls = spawn('git', ['ls-files']),
        // This gets the full path to each file in each submodule
        subls = spawn('git', ['submodule', 'foreach', 'for file in `git ls-files`; do echo "$path/$file"; done'])


    var mainFileList = '';
    gitls.stdout.on('data', function (data) {
        mainFileList += data;
    });
    gitls.on('exit', returnFileList);

    var subFileList = '';
    subls.stdout.on('data', function (data) {
        subFileList += data;
    });
    subls.on('exit', returnFileList);

    var lsCount = 0;
    function returnFileList(code) {
        lsCount++;
        if (lsCount < 2) {
            return;
        }
        process.chdir(cwd);

        // Convert \n separated list of filenames into a sorted array
        var fileList = (mainFileList.trim() + '\n' + subFileList.trim()).split('\n').filter(function(file) {
            // Ignore entering submodule messages
            if (file.indexOf('Entering ') === 0) {
                return;
            }

            // Ignore hidden and backup files
            if (file.split('/').pop()[0] == '.' || file[file.length - 1] == '~') {
                return;
            }

            // Submodules appear in ls-files but aren't files. Skip them
            if (fs.statSync(path.join(dir, file)).isDirectory()) {
                return;
            }

            
            return file;
        }).sort()

        callback(fileList);
    }

}

function copyFiles(files, dir, callback) {
    var realFiles = [];
    var copyFile = function(i) {
        var file = files[i],
            dst = path.join(dir, file),
            dirname = path.dirname(dst);

        realFiles.push(dst);
        
        mkdir(dirname);
        // console.log("Processing file: ", i, files.length, file);
        sys.pump(fs.createReadStream(file), fs.createWriteStream(dst, {mode: fs.statSync(file).mode}), function() {
            if (i < files.length - 1) {
                copyFile(i + 1);
            } else {
                callback(realFiles);
            }
        });
    }

    copyFile(0);
}

function generateZip(files, zipName) {
    zipName += '.zip';

    sys.puts('Generating .zip archive : ' + zipName);
    if (path.exists(zipName)) {
        fs.unlink(zipName);
    }

    var tar = spawn('zip', ['-9', zipName].concat(files));

    tar.stderr.on('data', function(data) {
        sys.print(data);
    });
    
    tar.on('exit', function() {
        sys.puts('Generated ' + zipName + ' archive');
    });
}
function generateGZip(files, zipName) {
    var folderName = zipName;
    zipName += '.tar.gz';
    sys.puts('Generating .tar.gz archive : ' + zipName);
    if (path.exists(zipName)) {
        fs.unlink(zipName);
    }

    copyFiles(files, folderName, function(realFiles) {
        var tar = spawn('tar', ['-czf', zipName].concat(realFiles));

        tar.stderr.on('data', function(data) {
            sys.print(data);
        });
        
        tar.on('exit', function() {
            sys.puts('Generated ' + zipName + ' archive');
        });
    });

}


(function main() {
    var dir = path.join(__dirname, '../')
    findFilesToPackage(dir, function(filesToPackage) {
        generateNSISScript(filesToPackage, function(nsis) {

            // Write out installer file
            var output = path.join(__dirname, 'windows-installer.nsi');
            fs.writeFileSync(output, nsis);

            // Generate installer
            sys.puts('Generating windows installer .EXE');
            var makensis = spawn('makensis', [output]);
            makensis.stderr.on('data', function (data) {
                sys.print(data);
            });
            makensis.on('exit', function (data) {
                sys.puts('Windows installer generated');

                fs.unlink(output);


                var cwd = process.cwd();
                process.chdir(dir);

                // Generate zip archives for all platforms
                generateGZip(filesToPackage, 'cocos2d-javascript-v' + VERSION + '-all');

                function removeNodeBuilds(files, platform) {
                    return files.filter(function(file) {
                        if (~file.indexOf('node-builds') && !~file.indexOf(platform) && !~file.indexOf('tmp') && !~file.indexOf('etc')) {
                            return;
                        }

                        return file;
                    });
                }

                // Mac OS X
                generateGZip(removeNodeBuilds(filesToPackage, 'osx'), 'cocos2d-javascript-v' + VERSION + '-mac');

                // Linux
                generateGZip(removeNodeBuilds(filesToPackage, 'lin'), 'cocos2d-javascript-v' + VERSION + '-linux');

                // Windows
                generateZip(removeNodeBuilds(filesToPackage, 'win'), 'cocos2d-javascript-v' + VERSION + '-windows');

                // Solaris
                generateGZip(removeNodeBuilds(filesToPackage, 'sol'), 'cocos2d-javascript-v' + VERSION + '-solaris');
            });
        });
    });
})();

