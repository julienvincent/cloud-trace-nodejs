import { BUILD_DIRECTORY, nodule, readFileP, forkP } from './utils';
import * as path from 'path';
import * as pify from 'pify';

const coveralls: {
  handleInput: (input: string, cb: (err: Error) => void) => void
} = require('coveralls');

const reportToCoverallsP = pify((input: string, cb: (err: Error) => void) => coveralls.handleInput(input, cb));

export default async function() {
  await forkP(nodule('istanbul/lib/cli'), [
    'report',
    'lcovonly'
  ], {
    cwd: BUILD_DIRECTORY
  });
  const lcov = await readFileP(`${BUILD_DIRECTORY}/coverage/lcov.info`, 'utf8');
  await reportToCoverallsP(lcov);
}
