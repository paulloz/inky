// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.
const $ = window.jQuery = require('./jquery-2.2.3.min.js');
const ipc = require("electron").ipcRenderer;
const util = require('util');
const assert = require('assert');
const path = require("path");
const DocumentManager = require('./electron-document-manager').getRendererModule();

const PlayerView = require("./playerView.js").PlayerView;
const ToolbarView = require("./toolbarView.js").ToolbarView;

var editor = ace.edit("editor");
var Range = ace.require("ace/range").Range;
var TokenIterator = ace.require("ace/token_iterator").TokenIterator;

const InkMode = require("./ace-ink-mode/ace-ink.js").InkMode;

editor.getSession().setMode(new InkMode());
editor.setShowPrintMargin(false);
editor.getSession().setUseWrapMode(true);
editor.setOptions({
    enableLiveAutocompletion: true
});

/* TODO: It's possible to complete custom keywords.
   Can do this when we have them parsed from the ink file.
var staticWordCompleter = {
    getCompletions: function(editor, session, pos, prefix, callback) {
        var wordList = ["foo", "bar", "baz"];
        callback(null, wordList.map(function(word) {
            return {
                caption: word,
                value: word,
                meta: "static"
            };
        }));

    }
}
editor.completers = [staticWordCompleter];
*/



var sessionId = 0;
var choiceSequence = [];
var currentReplayTurnIdx = -1;

var editorMarkers = [];
var editorAnnotations = [];
var editorChanges = 1;
var lastEditorChange = null;
var issues = [];
var selectedIssueIdx = -1;


editor.on("change", () => {
    lastEditorChange = Date.now();
    DocumentManager.setEdited(true);
});

// Unfortunately standard jquery events don't work since 
// Ace turns pointer events off
editor.on("click", function(e){

    // Have to hold down modifier key to jump
    if( !e.domEvent.altKey )
        return;

    var editor = e.editor;
    var pos = editor.getCursorPosition();
    var searchToken = editor.session.getTokenAt(pos.row, pos.column);

    if( searchToken && searchToken.type == "include.filepath" ) {
        alert("Jumping to INCLUDEs not yet supported!")
        return;
    }

    // Approximate search:
    //  - Split the search token up into its components: x.y.z
    //  - POS = clicked token
    //  - for each component:
    //       - find the *nearest* matching token to POS
    //       - POS = that matching component's pos
    //       - next component
    // Effectively it drills into the path, except that it's not
    // 100% accurate since it just tried to find the nearest, rather
    // than searching through the structure correctly.
    if( searchToken && searchToken.type == "divert.target" ) {

        e.preventDefault();

        var targetPath = searchToken.value;

        var pathComponents = targetPath.split(".");
        var foundSomeOfPath = false;

        for(var pathIdx=0; pathIdx<pathComponents.length; ++pathIdx) {

            // Remove parameters from target name
            var pathElementName = pathComponents[pathIdx];
            pathElementName = pathElementName.replace(/\([^\)]*\)/g, "");
            pathElementName = pathElementName.trim();

            function searchForName(forward) {
                var it = new TokenIterator(editor.session, pos.row, pos.column);
                for(var tok = it.getCurrentToken(); tok; forward ? tok = it.stepForward() : tok = it.stepBackward()) {
                    if( tok.type.indexOf("name") != -1 && tok.value == pathElementName ) {
                        return {
                            row: it.getCurrentTokenRow(),
                            column: it.getCurrentTokenColumn(),
                            found: true
                        };
                    }
                }
                return {
                    found: false
                };
            }

            var forwardSearchResult = searchForName(true);
            var backwardSearchResult = searchForName(false);
            var target = null;

            if( forwardSearchResult.found && backwardSearchResult.found ) {
                if( Math.abs(forwardSearchResult.row - pos.row) < Math.abs(backwardSearchResult.row - pos.row) ) {
                    target = forwardSearchResult;
                } else {
                    target = backwardSearchResult;
                }
            } else if( forwardSearchResult.found ) {
                target = forwardSearchResult;
            } else if( backwardSearchResult.found ) {
                target = backwardSearchResult;
            }

            if( target ) {
                pos = target;
                foundSomeOfPath = true;
            } else {
                break;
            }

        } // path component iteration

        if( foundSomeOfPath )
            editor.gotoLine(pos.row+1, pos.column);
    }
});

// Unfortunately standard CSS for hover doesn't work in the editor
// since they turn pointer events off.
editor.on("mousemove", function (e) {

    var editor = e.editor;

    // Have to hold down modifier key to jump
    if( e.domEvent.altKey ) {

        var character = editor.renderer.screenToTextCoordinates(e.x, e.y);
        var token = editor.session.getTokenAt(character.row, character.column);
        if( !token )
            return;

        var tokenStartPos = editor.renderer.textToScreenCoordinates(character.row, token.start);
        var tokenEndPos = editor.renderer.textToScreenCoordinates(character.row, token.start + token.value.length);

        const lineHeight = 12;
        if( e.x >= tokenStartPos.pageX && e.x <= tokenEndPos.pageX && e.y >= tokenStartPos.pageY && e.y <= tokenEndPos.pageY+lineHeight) {
            if( token ) {
                if( token.type == "divert.target" || token.type == "include.filepath" ) {
                    editor.renderer.setCursorStyle("pointer");
                    return;
                }
            }
        }
    }
    
    editor.renderer.setCursorStyle("default");
});

DocumentManager.setContentSetter(function(content) {
    editor.setValue(content);
});
 
DocumentManager.setContentGetter(function() {
    return editor.getValue();
});

var currentFilepath = null;
ipc.on("set-filepath", (event, filename) => {
    currentFilepath = filename;
    var baseFilename = path.basename(filename);
    $("h1.title").text(path.basename(filename));

    $(".sidebar .nav-group.main-ink .nav-group-item .filename").text(baseFilename)
});

function resetErrors() {
    var editorSession = editor.getSession();
    editorSession.clearAnnotations();
    editorAnnotations = [];

    for(var i=0; i<editorMarkers.length; i++) {
        editorSession.removeMarker(editorMarkers[i]);
    }
    editorMarkers = [];

    issues = [];
    selectedIssueIdx = -1;

    refreshIssueSummary();
}



function reloadInkForPlaying() {

    lastEditorChange = null;

    stop(sessionId);

    sessionId += 1;

    if( choiceSequence.length > 0 )
        currentReplayTurnIdx = 0;

    console.log("New session id in play(): "+sessionId);

    PlayerView.prepareForNextContent();

    resetErrors();

    ipc.send("play-ink", editor.getValue(), sessionId);
}

function stop(idToStop) {
    ipc.send("play-stop-ink", idToStop);
}

// Do first compile
// Really just for debug when loading ink immediately
// other actions will cause editor changes
setTimeout(reloadInkForPlaying, 1000);

// compile loop - detect changes every 0.25 and make sure
// user has paused before actually compiling
setInterval(() => {
    if( lastEditorChange != null && Date.now() - lastEditorChange > 500 ) {
        lastEditorChange = null;
        reloadInkForPlaying();
    }
}, 250);

function refreshIssueSummary() {

    var $message = $(".issuesMessage");
    var $summary = $(".issuesSummary");
    var $issues = $("#toolbar .issue-popup");
    var $issuesTable = $issues.children(".table");
    $issuesTable.empty();

    var errorCount = 0;
    var warningCount = 0;
    var todoCount = 0;

    var issuePriorties = {
        "ERROR": 1,
        "RUNTIME ERROR": 2,
        "WARNING": 3,
        "TODO": 4
    };

    issues.sort((i1, i2) => {
        var errorTypeDiff = issuePriorties[i1.type] - issuePriorties[i2.type];
        if( errorTypeDiff != 0 )
            return errorTypeDiff;
        else
            return i1.lineNumber - i2.lineNumber;
    });

    issues.forEach((issue) => {
        var errorClass = "";
        if( issue.type == "ERROR" || issue.type == "RUNTIME ERROR" ) {
            errorCount++;
            errorClass = "error";
        } else if( issue.type == "WARNING" ) {
            warningCount++;
            errorClass = "warning";
        } else if( issue.type == "TODO" ) {
            todoCount++;
            errorClass = "todo";
        }

        var $issueRow = $(`<div class="row ${errorClass}">
        <div class="col line-no">
          ${issue.lineNumber}
        </div>
        <div class="col issue">
          ${issue.message}
        </div>
        <img class="chevron" src="img/right-chevron.png"/>
      </div>`);

        $issueRow.click((e) => {
            editor.gotoLine(issue.lineNumber);
            e.preventDefault();
        });

        $issuesTable.append($issueRow);
    });

    if( errorCount == 0 && warningCount == 0 && todoCount == 0 ) {
        $summary.addClass("hidden");
        $message.text("No issues.");
        $message.removeClass("hidden");
        $issues.addClass("hidden");
    } else {
        $message.addClass("hidden");
        function updateCount(className, count) {
            var $issueCount = $summary.children(".issueCount."+className);
            if( count == 0 )
                $issueCount.hide();
            else {
                $issueCount.show();
                $issueCount.children("span").text(count);
            }
        }

        updateCount("error", errorCount);
        updateCount("warning", warningCount);
        updateCount("todo", todoCount);
        $summary.removeClass("hidden");

        updateIssuesPopupPosition();
    }
}

function updateIssuesPopupPosition() {
    var $issues = $("#toolbar .issue-popup");
    $issues.css({
        left: 0.5*$(window).width() - 0.5*$issues.width()
    });
}


ipc.on("next-issue", () => {
    if( issues.length > 0 ) {
        selectedIssueIdx++;
        if( selectedIssueIdx >= issues.length )
            selectedIssueIdx = 0;
        editor.gotoLine(issues[selectedIssueIdx].lineNumber);
    }
});

ipc.on("play-generated-text", (event, result, fromSessionId) => {

    if( fromSessionId != sessionId )
        return;

    var replaying = currentReplayTurnIdx != -1;
    var animated = !replaying;
    PlayerView.addTextSection(result, animated);
});

ipc.on("play-generated-error", (event, error, fromSessionId) => {
    
    if( sessionId != fromSessionId )
        return;

    var editorErrorType = "error";
    var editorClass = "ace-error";
    if( error.type == "WARNING" ) {
        editorErrorType = "warning";
        editorClass = "ace-warning";
    }
    else if( error.type == "TODO" ) {
        editorErrorType = "information";
        editorClass = 'ace-todo';
    }

    editorAnnotations.push({
      row: error.lineNumber-1,
      column: 0,
      text: error.message,
      type: editorErrorType
    });
    editor.getSession().setAnnotations(editorAnnotations);

    var aceClass = "ace-error";
    var markerId = editor.session.addMarker(
        new Range(error.lineNumber-1, 0, error.lineNumber, 0),
        editorClass, 
        "line",
        false
    );
    editorMarkers.push(markerId);

    if( error.type == "RUNTIME ERROR" ) {
        PlayerView.addLineError(error, () => {
            editor.gotoLine(error.lineNumber);
        });
    }

    issues.push(error);

    refreshIssueSummary();
});

ipc.on("play-generated-choice", (event, choice, fromSessionId) => {

    if( fromSessionId != sessionId )
        return;

    var animated = false;
    if( currentReplayTurnIdx == choiceSequence.length )
        currentReplayTurnIdx = -1;
    else
        animated = true;

    if( currentReplayTurnIdx == -1 || currentReplayTurnIdx >= choiceSequence.length ) {
        PlayerView.addChoice(choice, animated, () => {
            ipc.send("play-continue-with-choice-number", choice.number, fromSessionId);
            choiceSequence.push(choice.number);
        });
    }
});



ipc.on("play-requires-input", (event, fromSessionId) => {

    if( fromSessionId != sessionId )
        return;

    PlayerView.scrollToBottom();

    // Replay?
    if( currentReplayTurnIdx >= 0 && currentReplayTurnIdx < choiceSequence.length ) {

        PlayerView.addHorizontalDivider();

        var replayChoiceNumber = choiceSequence[currentReplayTurnIdx];
        currentReplayTurnIdx++;
        ipc.send("play-continue-with-choice-number", replayChoiceNumber, fromSessionId);
    }
});

ipc.on("play-story-completed", (event, fromSessionId) => {

    console.log("play-story-completed from "+fromSessionId);
    if( fromSessionId != sessionId )
        return;

    PlayerView.addTerminatingMessage("End of story", "end");
});

ipc.on("play-story-unexpected-exit", (event, fromSessionId) => {

    console.log("play-story-unexpected-exit from "+fromSessionId);
    if( sessionId != fromSessionId ) 
        return;

    PlayerView.addTerminatingMessage("Error in story", "error");
});

ipc.on("play-story-stopped", (event, fromSessionId) => {
    console.log("play-story-stopped from "+fromSessionId);
});

ToolbarView.setButtonActions({
    rewind: () => {
        choiceSequence = [];
        currentReplayTurnIdx = -1;
        reloadInkForPlaying();
    },
    stepBack: () => {
        if( choiceSequence.length > 0 )
            choiceSequence.splice(-1, 1);
        reloadInkForPlaying();
    }
})


$(document).ready(function() {
    $(window).resize(() => {
        updateIssuesPopupPosition();
    });
});
