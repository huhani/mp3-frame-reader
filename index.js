var fs = require('fs');

var MP3FileReader = function() {
    var MIN_BUFFER_SIZE = 0x01 << 0x10;
    var MAX_BUFFER_SIZE = MIN_BUFFER_SIZE * 2;
    var MAX_NEXT_BUFFER_TRACK_THRESHOLD = 20;
    var MIN_CORRECT_FRAME_COUNT = 5;

    var BitratesMap = [
        32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
        32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
        32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
        8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    var SamplingRateMap = [44100, 48000, 32000, 22050, 24000, 16000, 11025, 12000, 8000];

    function MP3FileReader(filepath, onFrame) {
        var aborted = false;
        var hasEnded = false;
        var __resolve = null;
        var __reject = null;
        var isSettled = function() {
            return hasEnded && aborted;
        };
        var AbortFn = function() {
            if(!isSettled()) {
                console.log(88884848);
                aborted = true;
                __reject(new Error('Aborted.'));
            }
        };

        var promise = new Promise(function(resolve, reject) {
            __resolve = resolve;
            __reject = reject;
            getFileSize(filepath).then(function(filesize){
                if(aborted) {
                    return;
                }
                var	readStream = fs.createReadStream( filepath , { highWaterMark: MIN_BUFFER_SIZE} );
                var isReadable = false;
                var startOffset = 0;
                var endOffset = 0;
                var ID3v2TagEndOffset = null;
                var currentBuffer = null;
                var hasStart = false;
                var requireMoreRead = false;
                var totalTime = 0;
                var totalFrameSize = 0;
                var frameCount = 0;
                var lastFrameOffset = 0;

                var bufferTrackCount = 0;
                var totalBufferTrackingCount = 0;
                var frameGroups = [];

                var lastSampleRateFrameCount = 0;
                var lastSampleRateStartOffset = null;
                var lastSampleRateEndOffset = null;
                var lastSampleRate = null;
                var lastSampleDuration = 0;
                var lastBitrate = null;
                var isVBR = false;
                var loadedMP3Header = false;
                var MP3Header = null;

                readStream.on('readable', function() {
                    //( '>> readable event'  );

                    isReadable = true;
                    if(!hasStart || requireMoreRead) {
                        hasStart = true;
                        isReadable = false;
                        requireMoreRead = false;
                        this.read();
                    }
                });

                readStream.on('open', function () {
                    //console.log( '>> open event' );
                });

                readStream.on('data', function(chunk) {
                    //console.log( '>> data  event : chunk size = %d', chunk.length );
                    onData.call(this, chunk);
                });

                readStream.on('end', function() {
                    hasEnded = true;
                    flushSampleRateOffset();
                    _resolve();
                    //console.log( '>> end event'  );
                });

                readStream.on('close', function() {
                    //console.log( '>> close event'  );
                });

                readStream.on('error', function(err) {
                    hasEnded = true;
                    reject(err);
                    //console.log( 'err = %j', err );
                });

                var isResolved = false;

                function _resolve() {
                    if(!isResolved && !aborted) {
                        isResolved = true;
                        frameGroups = frameGroups.filter(function(each){
                            if(!!(each && each.frames && each.frames >= MIN_CORRECT_FRAME_COUNT)) {
                                return true;
                            }
                            frameCount -= each.frames;

                            return false;
                        });
                        var durationFromFrameGroups = frameGroups.reduce(function(obj, current){
                            if(current.duration) {
                                obj.duration += current.duration;
                            }
                            if(current.frames) {
                                obj.frameCount += current.frames;
                            }
                            obj.streamSize += current.end-current.start;

                            return obj;
                        }, {
                            duration: null,
                            streamSize: 0,
                            frameCount: 0
                        });
                        var bitrate = null;
                        if(durationFromFrameGroups.duration && durationFromFrameGroups.streamSize) {
                            bitrate = Math.round((durationFromFrameGroups.streamSize << 3) / durationFromFrameGroups.duration / 1000);
                        }
                        resolve({
                            fileSize: filesize,
                            streamSize: durationFromFrameGroups.streamSize,
                            duration: durationFromFrameGroups && durationFromFrameGroups.duration || totalTime,
                            bitrate: bitrate,
                            frameCount: durationFromFrameGroups && durationFromFrameGroups.frameCount || frameCount,
                            isVBR: isVBR,
                            frameGroups: frameGroups,
                            isCorrectFile: frameGroups.length === 1
                        });
                    }
                }

                function flushSampleRateOffset(lastOffset, startOffset, sampleRate) {
                    var sampleRateStartOffset = lastSampleRateStartOffset;
                    var sampleRateEndOffset = lastOffset ? lastOffset : lastSampleRateEndOffset;
                    if(sampleRateStartOffset !== null && sampleRateEndOffset !== null) {
                        var calcDuration = null;
                        if(lastSampleRate && lastSampleRateFrameCount && MP3Header && MP3Header.samplePerFrame) {
                            calcDuration = lastSampleRateFrameCount * MP3Header.samplePerFrame / lastSampleRate;
                        }
                        var duration = calcDuration !== null ? calcDuration : lastSampleDuration;
                        var bitrate = duration && sampleRateEndOffset ? Math.round(((sampleRateEndOffset-sampleRateStartOffset) << 3) / duration / 1000) : null;
                        frameGroups.push({
                            start: sampleRateStartOffset,
                            end: sampleRateEndOffset,
                            sampleRate: lastSampleRate,
                            frames: lastSampleRateFrameCount,
                            duration: duration,
                            bitrate: bitrate,
                            header: MP3Header
                        });
                    }
                    lastSampleRate = sampleRate ? sampleRate : null;
                    lastSampleRateStartOffset = startOffset ? startOffset : null;
                    lastSampleRateEndOffset = null;
                    lastSampleRateFrameCount = 0;
                    lastSampleDuration = 0;
                    MP3Header = null;
                }

                function onData(chunk) {
                    endOffset += chunk.length;
                    if(!currentBuffer) {
                        currentBuffer = chunk;
                    } else {
                        currentBuffer = Buffer.concat([currentBuffer, chunk]);
                        if(currentBuffer.length > MAX_BUFFER_SIZE) {
                            var diff = currentBuffer.length-MAX_BUFFER_SIZE;
                            currentBuffer = currentBuffer.slice(diff);
                            startOffset += diff;
                        }
                    }

                    if(ID3v2TagEndOffset === null) {
                        ID3v2TagEndOffset = getID3v2TagLength(chunk);
                        if(ID3v2TagEndOffset) {
                            lastFrameOffset = ID3v2TagEndOffset;
                        }
                        if(ID3v2TagEndOffset+1 >= filesize) {
                            this.destroy();
                            isResolved = true;
                            return reject(new Error("MP3 frame was escaped from origin file."));
                        }
                    }

                    if(startOffset<lastFrameOffset && lastFrameOffset+25 < endOffset) {
                        var tagFrameSizeDiff = lastFrameOffset-startOffset;
                        currentBuffer = currentBuffer.slice(tagFrameSizeDiff);
                        startOffset += tagFrameSizeDiff;
                    }

                    if(!ID3v2TagEndOffset || (ID3v2TagEndOffset && startOffset >= ID3v2TagEndOffset)) {
                        var headerStartOffset = currentBuffer.indexOf(0xFF);
                        if(headerStartOffset > -1) {
                            if(headerStartOffset > 0) {
                                currentBuffer = currentBuffer.slice(headerStartOffset);
                                startOffset += headerStartOffset;
                                lastFrameOffset = startOffset;
                            }
                        } else if(!(endOffset === filesize || endOffset-lastFrameOffset <= 128)) {
                            this.destroy();
                            isResolved = true;
                            return reject(new Error('Cannot found mp3 header.'));
                        }
                    }

                    var frameSizeDiff = 0;
                    while(lastFrameOffset+(loadedMP3Header ? 25 : 4096)<endOffset) {
                        var frameData = doFrameStuff(currentBuffer.slice(frameSizeDiff, !loadedMP3Header ? frameSizeDiff+4096 : frameSizeDiff+4), !loadedMP3Header);
                        if(frameData) {
                            loadedMP3Header = true;
                            frameCount++;
                            lastSampleRateFrameCount++;
                            var thisFrameSize = frameData.frameLength;
                            if(onFrame) {
                                onFrame(frameData, lastFrameOffset, lastFrameOffset+thisFrameSize, false);
                            }
                            if(!lastSampleRateStartOffset) {
                                lastSampleRateStartOffset = lastFrameOffset;
                            }
                            if(!lastSampleRateEndOffset) {
                                lastSampleRateStartOffset = lastFrameOffset;
                            }

                            totalTime += frameData.duration;
                            lastSampleDuration += frameData.duration;
                            lastFrameOffset += thisFrameSize;
                            totalFrameSize += thisFrameSize;
                            frameSizeDiff += thisFrameSize;
                            lastSampleRateEndOffset = lastFrameOffset;
                            if(!isVBR && lastSampleRateFrameCount >= MIN_CORRECT_FRAME_COUNT) {
                                if(lastBitrate === null) {
                                    lastBitrate = frameData.bitRate;
                                } else if(lastBitrate !== frameData.bitRate) {
                                    isVBR = true;
                                }
                            }
                            if(!MP3Header) {
                                MP3Header = frameData.header;
                            }

                            if(lastSampleRate === null) {
                                lastSampleRate = frameData.sampleRate;
                            } else if(lastSampleRate !== frameData.sampleRate) {
                                flushSampleRateOffset(lastFrameOffset-thisFrameSize, lastFrameOffset, lastSampleRate);
                            }

                            bufferTrackCount = 0;
                        } else {
                            flushSampleRateOffset();
                            loadedMP3Header = false;
                            if(onFrame) {
                                onFrame(void 0, null, null, true);
                            }
                            if(bufferTrackCount++ <= MAX_NEXT_BUFFER_TRACK_THRESHOLD) {
                                var findNextHeader = currentBuffer.indexOf(0xFF, frameSizeDiff+1);
                                if(findNextHeader > -1) {
                                    totalBufferTrackingCount++;
                                    var nextHeaderOffsetDiff = findNextHeader-frameSizeDiff;
                                    frameSizeDiff = findNextHeader;
                                    lastFrameOffset += nextHeaderOffsetDiff;
                                    continue;
                                }
                            }

                            return _resolve();
                            this.destroy();
                            break;
                        }
                    }

                    if(frameSizeDiff) {
                        if(frameSizeDiff > currentBuffer.length) {
                            startOffset += currentBuffer.length;
                            currentBuffer = null;
                        } else {
                            currentBuffer = currentBuffer.slice(frameSizeDiff);
                            startOffset += frameSizeDiff;
                        }
                    }

                    if((startOffset<ID3v2TagEndOffset+(loadedMP3Header ? 25 : 4096) || startOffset+MIN_BUFFER_SIZE>=endOffset || lastFrameOffset>=endOffset) && endOffset<filesize-1) {
                        if(isReadable) {
                            isReadable = false;
                            this.read();
                        } else if(!requireMoreRead) {
                            requireMoreRead = true;
                        }
                    } else {
                        this.destroy();
                        flushSampleRateOffset();
                        return _resolve();
                    }
                }

            })['catch'](function(err){
                if(!aborted) {
                    reject(err);
                }
            });
        });

        return {
            abort: AbortFn,
            isSettled: isSettled,
            promise: promise
        };
    }

    function getFileSize(filepath) {
        return new Promise(function(resolve, reject) {
            fs.stat(filepath, function(error, data){
                if(error) {
                    reject(error);
                }

                resolve(data.size);
            });
        });
    }

    function ReadInt(buffer) {
        var result = buffer.charCodeAt(0);
        for (var i = 1; i < buffer.length; ++i) {
            result <<= 8;
            result += buffer.charCodeAt(i);
        }

        return result;
    }

    function getID3v2TagLength(block) {
        var bufToStr = block.toString();
        if(bufToStr.substring(0, 3) === 'ID3') {
            var id3v2Flag = bufToStr.charAt(5);
            var flagFooterPresent = id3v2Flag & 0x10 ? 1 : 0;
            var z0 = bufToStr.charAt(6).charCodeAt();
            var z1 = bufToStr.charAt(7).charCodeAt();
            var z2 = bufToStr.charAt(8).charCodeAt();
            var z3 = bufToStr.charAt(9).charCodeAt();
            if((z0 & 0x80) === 0 && (z1 & 0x80) === 0 && (z2 & 0x80)=== 0 && (z3 & 0x80)=== 0) {
                var headerSize = 10;
                var tagSize = ((z0&0x7f) * 0x200000) + ((z1&0x7f) * 0x4000) + ((z2&0x7f) * 0x80) + (z3&0x7f);
                var footerSize = flagFooterPresent ? 10 : 0;

                return headerSize + tagSize + footerSize;
            }
        }

        return 0;
    }

    function doFrameStuff(data, readeHeader) {
        if(data.length < 2) {
            return null;
        }


        // This section to read mp3 header is referred from https://github.com/tchakabam/multimedia-js/tree/b433e471c52cafb18308e859cf740acf3222521c
        if(data[0] === 0xFF || (data[1] & 0xE0) === 0xE0) {
            var headerOfVersion = (data[1] >> 3) & 3;
            var headerOfLayer = (data[1] >> 1) & 3;
            var headerOfBitrate = (data[2] >> 4) & 15;
            var headerOfFrequency = (data[2] >> 2) & 3;
            var headerOfPadding = !!(data[2] & 2);
            if(headerOfVersion !== 1 && headerOfBitrate !== 0 && headerOfBitrate !== 15 && headerOfFrequency !== 3) {
                var columnInBitrates = headerOfVersion === 3 ? (3 - headerOfLayer) : (headerOfLayer === 3 ? 3 : 4);
                var bitRate = BitratesMap[columnInBitrates * 14 + headerOfBitrate - 1];
                var columnInSampleRates = headerOfVersion === 3 ? 0 : headerOfVersion === 2 ? 1 : 2;
                var sampleRate = SamplingRateMap[columnInSampleRates * 3 + headerOfFrequency];
                var padding = headerOfPadding ? 1 : 0;
                var frameLength = headerOfLayer === 3 ?
                    ((headerOfVersion === 3 ? 12 : 6) * bitRate * 1000 / sampleRate + padding) << 2 :
                    ((headerOfVersion === 3 ? 144 : 72) * bitRate * 1000 / sampleRate + padding) | 0;


                // This source as reading Vbr header has been referred from https://developers.google.com/web/updates/2015/06/Media-Source-Extensions-for-Audio
                var MP3Header = null;
                if(readeHeader && data.length >= 4096) {
                    var secondPerSample = 1/sampleRate;
                    var dataStr = String.fromCharCode.apply(null, data.slice(0, 4096));

                    var paddedSamples = 0;
                    var frontPadding = 0;
                    var endPadding = 0;
                    var realSamples = 0;
                    var frameCount = null;
                    var xingDataIndex = dataStr.indexOf('Xing');
                    if (xingDataIndex === -1) {
                        xingDataIndex = dataStr.indexOf('Info');
                    }
                    if(xingDataIndex > -1) {
                        var frameCountIndex = xingDataIndex + 8;
                        frameCount = ReadInt(dataStr.substr(frameCountIndex, 4));
                        paddedSamples = (frameCount * (headerOfVersion === 3 ? 144 : 72)) << 3;
                        xingDataIndex = dataStr.indexOf('LAME');
                        if (xingDataIndex === -1) {
                            xingDataIndex = dataStr.indexOf('Lavf');
                        }
                        if(xingDataIndex > -1) {
                            var gaplessDataIndex = xingDataIndex + 21;
                            var gaplessBits = ReadInt(dataStr.substr(gaplessDataIndex, 3));
                            frontPadding = gaplessBits >> 12;
                            endPadding = gaplessBits & 0xFFF;

                        }
                        realSamples = paddedSamples - (frontPadding + endPadding);
                    }

                    MP3Header = {
                        frames: frameCount,
                        samplePerFrame: (headerOfVersion === 3 ? 144 : 72) << 3,
                        samples: null,
                        frontPadding: null,
                        endPadding: null,
                        realSamples: null,
                        totalDuration: null,
                        realSampleDuration: null,
                        frontPaddingDuration: null
                    };

                    if(paddedSamples || realSamples || frontPadding) {
                        MP3Header.samples = paddedSamples;
                        MP3Header.frontPadding = frontPadding;
                        MP3Header.endPadding = endPadding;
                        MP3Header.realSamples = realSamples;
                        MP3Header.totalDuration = paddedSamples * secondPerSample;
                        MP3Header.realSampleDuration = realSamples * secondPerSample;
                        MP3Header.frontPaddingDuration = frontPadding * secondPerSample;
                    }
                }

                return {
                    bitRate: bitRate,
                    sampleRate: sampleRate,
                    frameLength: frameLength,
                    duration: frameLength ? (frameLength << 3) / (bitRate * 1000) : 0,
                    header: MP3Header
                };
            }
        }

        return null;
    }

    return MP3FileReader;

}();

module.exports = MP3FileReader;
