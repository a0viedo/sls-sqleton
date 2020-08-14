'use strict';

const fs = require('fs');
const util = require('util');
const sqlite = require('sqlite3')
const extname = require('path').extname
const open = require('fs').createWriteStream
const sqleton = require('sqleton');
const rimraf = require('rimraf-promise');
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const execSync = require('child_process').execSync;
const spawn = require('child_process').spawn;
const parser = require('lambda-multipart-parser');

process.env['PATH'] = `${process.env['PATH']}:/opt/graphviz/bin`;
process.env['LD_LIBRARY_PATH'] = `${process.env['LD_LIBRARY_PATH']}:/opt/graphviz/lib64`;
module.exports.generate = async (event, context) => {
  const awsInvocationId = context.awsRequestId;
  const svgFilename = `/tmp/${awsInvocationId}.svg`;
  const qsParams = event.queryStringParameters || {};

  const sqliteFilePath = `/tmp/${awsInvocationId}.sqlite`;
  await writeFile(sqliteFilePath, event.body, { encoding: 'base64'});
  const vOutput = execSync(`dot_static -V`, { encoding: 'utf8' });
  console.log('dot_static output', vOutput);
  const svgContent = await generateSVGFromSqliteFile(sqliteFilePath, svgFilename, qsParams);
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
      'Content-Type': 'image/svg+xml',
    },
    body: svgContent
  }
};

module.exports.generateWithMultipart = async (event, context) => {
  const awsInvocationId = context.awsRequestId;
  const svgFilename = `/tmp/${awsInvocationId}.svg`;
  const result = await parser.parse(event);
  const qsParams = event.queryStringParameters || {};

  if(result.files.length > 1 ) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: 'Invalid number of files, only 1 file supported.'
      })
    }
  }

  qsParams.title = result.files[0].filename;

  const sqliteFilePath = `/tmp/${awsInvocationId}.sqlite`;
  await writeFile(sqliteFilePath, result.files[0].content, { encoding: 'base64' });
  const svgContent = await generateSVGFromSqliteFile(sqliteFilePath, svgFilename, qsParams);
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
      'Content-Type': 'image/svg+xml',
    },
    body: svgContent
  }
};

function generateSVGFromSqliteFile(sqliteFilePath, svgFilename, qsParams) {
  const { direction = 'LR', font = 'Helvetica', layout = 'fdp', title } = qsParams;
  const edgeLabels = qsParams.edgeLabels === 'true';

  return new Promise(async (resolve, reject) => {
    console.log('opening the db');
    const db = new sqlite.Database(sqliteFilePath, sqlite.OPEN_READONLY, async error => {
      if (error) {
        console.log('error', error);
        return;
      }
    
      let format = extname(svgFilename).slice(1);
      let stream, proc;
      if (format !== 'dot') {
        proc = spawn('dot_static', [`-T${format}`, `-o${svgFilename}`]);
        proc.stderr.pipe(process.stderr);
        stream = proc.stdin;
      } else {
        stream = open(svgFilename, { autoClose: true })
      }

      await sqleton(db, stream, {
        direction,
        font,
        layout,
        title,
        edgeLabels
      });
      db.close();
      stream.end();
      proc.on('close', async (code) => {
        console.log(`child process close all stdio with code ${code}`);
        if(code !== 0) {
          await rimraf('/tmp/*');
          return resolve({
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Internal server error' })
          })
        }
        console.log('svg file created');
        const svgFile = await readFile(svgFilename, { encoding: 'utf8' });
        console.log('read file');
        await rimraf('/tmp/*');
        console.log('cleaned /tmp');

        resolve(svgFile);
      });
    });
  });
}
