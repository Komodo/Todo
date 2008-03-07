/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 * 
 * The contents of this file are subject to the Mozilla Public License
 * Version 1.1 (the "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 * 
 * Software distributed under the License is distributed on an "AS IS"
 * basis, WITHOUT WARRANTY OF ANY KIND, either express or implied. See the
 * License for the specific language governing rights and limitations
 * under the License.
 * 
 * The Original Code is Komodo code.
 * 
 * The Initial Developer of the Original Code is ActiveState Software Inc.
 * Portions created by ActiveState Software Inc are Copyright (C) 2000-2008
 * ActiveState Software Inc. All Rights Reserved.
 * 
 * Contributor(s):
 *   ActiveState Software Inc
 *   Renato Raver
 * 
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 * 
 * ***** END LICENSE BLOCK ***** */

/**
 * An extension to list TODO items found in opened files / projects.
 * Features:
 *  - regex search markers
 *  - case sensitibity
 *  - search in current file or opened files
 *  - double-click to jump to file
 *  - next, previous buttons to jump between markers
 * Updates results on:
 *  - File open
 *  - File close
 *  - File save
 *  - View changed
 */

// Setup namespace
if (typeof(ko) == 'undefined') {
    var ko = {};
}
if (typeof(ko.extensions) == 'undefined') {
    ko.extensions = {};
}

// Make todo extension namespace and add our js code
ko.extensions.todo = {};
(function() {
    /* Private variables */
    var todoId = 0x2D0; // 720, special xul id needed by the FindResults code
    var todoSearcher = null;
    var log = ko.logging.getLogger("ko.extensions.todo");

    this.TodoSearcher = function() {
        try {		
            this._locale = Components.classes["@mozilla.org/intl/stringbundle;1"]
                    .getService(Components.interfaces.nsIStringBundleService).createBundle("chrome://todo/locale/todo.properties");
            this._needsUpdating = false;
            this._updateTimeoutId = null;
            this._currentSearchContext = this.GetLocalizedString('todo.currentFile');
            this._markers = this.GetLocalizedString('todo.pattern');
            this._caseSensitive = true;
            this._origFindOptions = new Object();
            this._todoFindOptions = Components.classes["@activestate.com/koFindOptions;1"]
                        .createInstance(Components.interfaces.koIFindOptions);
            this._todoFindOptions.patternType = this._todoFindOptions.FOT_REGEX_PYTHON;
            this._todoFindContext = Components.classes["@activestate.com/koFindContext;1"]
                        .createInstance(Components.interfaces.koIFindContext);
            this._todoFindContext.type = Components.interfaces.koIFindContext.FCT_CURRENT_DOC;

            // Initialize settings from prefs
            this.loadFromPrefs();

            // Listen for some Komodo view events
            var obsSvc = Components.classes["@mozilla.org/observer-service;1"].
                               getService(Components.interfaces.nsIObserverService);
            obsSvc.addObserver(this, 'view_opened', false);
            obsSvc.addObserver(this, 'view_closed', false);
            obsSvc.addObserver(this, 'current_view_changed', false);
            obsSvc.addObserver(this, 'file_changed', false);
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.TodoSearcher.prototype.loadFromPrefs = function() {
        var prefsSvc = Components.classes["@activestate.com/koPrefService;1"].
                                getService(Components.interfaces.koIPrefService);
        var prefs = prefsSvc.prefs;

        if (prefs.hasStringPref("ko.extensions.todo.markers")) {
            this._markers = prefs.getStringPref("ko.extensions.todo.markers");
        }
        document.getElementById("todo_markers_textbox").value = this._markers;

        if (prefs.hasStringPref("ko.extensions.todo.search_context")) {
            this._currentSearchContext = prefs.getStringPref("ko.extensions.todo.search_context");
        }
        document.getElementById("todo_search_context_button").label = this._currentSearchContext;

        if (prefs.hasBooleanPref("ko.extensions.todo.case_sensitive")) {
            this._caseSensitive = prefs.getBooleanPref("ko.extensions.todo.case_sensitive");
        }
        document.getElementById("todo_search_case_sensitive").checked = this._caseSensitive;
    }

    this.TodoSearcher.prototype.saveToPrefs = function() {
        var prefsSvc = Components.classes["@activestate.com/koPrefService;1"].
                                getService(Components.interfaces.koIPrefService);
        var prefs = prefsSvc.prefs;

        prefs.setStringPref("ko.extensions.todo.markers", this._markers);
        prefs.setStringPref("ko.extensions.todo.search_context", this._currentSearchContext);
        prefs.setBooleanPref("ko.extensions.todo.case_sensitive", this._caseSensitive);
    }

    this.TodoSearcher.prototype.observe = function(topic, subject, data) {
        try {
            switch (subject) {
                case "current_view_changed":
                    if (this._needsUpdating ||
                        (this._currentSearchContext == this.GetLocalizedString('todo.currentFile'))) {
                        // topic in this case is the new view
                        this.update(topic);
                        this._needsUpdating = false;
                    }
                    break;

                case "view_opened":
                case "view_closed":
                    this._needsUpdating = true;
                    break;

                case "file_changed":
                    // This notification is a little mis-leading, this usually
                    // means that the file was saved or the file was reverted.
                    if (!this._updateTimeoutId) {
                        var self = this;
                        var update_func = function() {
                            self._updateTimeoutId = null;
                            self.update();
                        }
                        // Update 1 seconds after the file save event
                        this._updateTimeoutId = window.setTimeout(update_func,
                                                                  1000);
                    }
                    break;
            }
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.TodoSearcher.prototype.update = function(view) {
        try {
            if (this._updateTimeoutId) {
                // We are updating now, don't need to wait for the timeout
                window.clearTimeout(this._updateTimeoutId);
                this._updateTimeoutId = null;
            }
            if (typeof(view) == 'undefined') {
                view = ko.views.manager.currentView;
            }
            this.findAll(window, view, this._todoFindContext, this._markers);
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.TodoSearcher.prototype.GetTodoTab = function(id) {
        try {
            // Create the tab or clear it and return its manager.
            var manager = _gFindResultsTab_managers[id];
            if (manager == null) {
                manager = _FindResultsTab_Create(id);
                _gFindResultsTab_managers[id] = manager;
            } else {
                manager.clear();
            }
            return manager;
        } catch(ex) {
            log.exception(ex);
        }
        return null;
    }

    this.TodoSearcher.prototype.findAll = function(editor, view, context, pattern, patternAlias) {
        if (findSvc == null) {
            findSvc = Components.classes["@activestate.com/koFindService;1"]
                      .getService(Components.interfaces.koIFindService);
        }

        var resultsMgr = this.GetTodoTab(todoId);
        if (resultsMgr == null)
            return null;
        // We need a view which contains scintilla, bug 70309 and we
        // need to catch errors when this fails, bug 70730 and bug 70708
        try {
            if (!view || !view.scintilla)
                return null;
        } catch (ex) {
            /* no view left */
            return null;
        }

        // Set the find context
        if (this._currentSearchContext == this.GetLocalizedString('todo.openedFiles')) {
            todoSearcher._todoFindContext.type = Components.interfaces.koIFindContext.FCT_ALL_OPEN_DOCS;
        } else {
            todoSearcher._todoFindContext.type = Components.interfaces.koIFindContext.FCT_CURRENT_DOC;
        }
        // Set the case sensitive find option
        if (this._caseSensitive) {
            this._todoFindOptions.caseSensitivity = this._todoFindOptions.FOC_SENSITIVE;
        } else {
            this._todoFindOptions.caseSensitivity = this._todoFindOptions.FOC_INSENSITIVE;
        }

        resultsMgr.configure(pattern, patternAlias, null, context,
                             this._todoFindOptions);
        // Don't use show, pops open the output tab when it's closed!
        //resultsMgr.show();

        resultsMgr.searchStarted();
        var numFilesSearched = null;

        // Save original find settings
        this._origFindOptions.searchBackward = findSvc.options.searchBackward;
        this._origFindOptions.matchWord= findSvc.options.matchWord;
        this._origFindOptions.patternType = findSvc.options.patternType;
        this._origFindOptions.caseSensitivity = findSvc.options.caseSensitivity;
    
        findSvc.options.searchBackward = false;
        findSvc.options.matchWord = false;
        findSvc.options.patternType = this._todoFindOptions.patternType;
        findSvc.options.caseSensitivity = this._todoFindOptions.caseSensitivity;
        try {
            if (context.type == Components.interfaces.koIFindContext.FCT_CURRENT_DOC
                || context.type == Components.interfaces.koIFindContext.FCT_SELECTION) {
                //log.debug("Find_FindAll: find all in '"+
                //              editor.ko.views.manager.currentView.document.displayPath+"'\n");
                _FindAllInView(editor, view, context,
                               pattern, resultsMgr.view);
            } else if (context.type == Components.interfaces.koIFindContext.FCT_ALL_OPEN_DOCS) {
                var viewURI;
                numFilesSearched = 0;
                while (view) {
                    viewURI = view.document.displayPath;
                    if (gFindSession.HaveSearchedThisUrlAlready(viewURI)) {
                        log.debug("findAll: have already searched '"+
                                      viewURI+"'\n");
                        break;
                    }

                    log.debug("findAll: find all in '"+viewURI+"'\n");
                    _FindAllInView(editor, view, context, pattern, resultsMgr.view);
                    numFilesSearched += 1;

                    view = _GetNextView(editor, view);
                }
            } else {
                throw("unexpected context: name='" + context.name + "' type=" +
                      context.type);
            }
            // Would be good to pass in the number of files in which hits were
            // found, but don't easily have that value and it's not a biggie.
            resultsMgr.searchFinished(true, resultsMgr.view.rowCount, null,
                                      numFilesSearched);
        } catch(ex) {
            log.exception(ex);
            return null;
        } finally {
            // Restore original find settings
            findSvc.options.searchBackward = this._origFindOptions.searchBackward;
            findSvc.options.matchWord = this._origFindOptions.matchWord;
            findSvc.options.patternType = this._origFindOptions.patternType;
            findSvc.options.caseSensitivity = this._origFindOptions.caseSensitivity;
        }

        var numTodosFound = resultsMgr.view.rowCount;
        gFindSession.Reset();

        //RRaver updates
        if (numTodosFound > 0) {
            //Mimics the Komodo internal behavior
            var elt = document.getElementById('cmd_viewBottomPane');
            var boxId = elt.getAttribute('box');
            var box = document.getElementById(boxId);
            
            if (! box.hasAttribute('collapsed') || box.getAttribute("collapsed") == "false") {
                this.UpdateTodoStatusbar(true);
            } else {
                this.UpdateTodoStatusbar(false, this.GetFormattedString('todo.todosFound', [numTodosFound]) );
            }
        } else {
            this.UpdateTodoStatusbar(true);
        }
        //RRaver updates END

        return numTodosFound;
    }
	
    //RRaver updates
    this.TodoSearcher.prototype.UpdateTodoStatusbar = function(hide, tooltip) {
        var todoStatus = document.getElementById('statusbar-todo');
        todoStatus.setAttribute("tooltiptext", tooltip || '');
        todoStatus.hidden = hide;
    }
    
    this.TodoSearcher.prototype.GetLocalizedString = function(str) {
        return this._locale.GetStringFromName(str);
    }
    
    this.TodoSearcher.prototype.GetFormattedString = function(str, ar) {
        return this._locale.formatStringFromName(str, ar, ar.length);
    }
    //RRaver updates END

    /* Exposed non-class functions */
    this.ChangeSearchContext = function(newContext) {
        if (newContext != todoSearcher._currentSearchContext) {
            todoSearcher._currentSearchContext = newContext;
            todoSearcher.update();
            document.getElementById("todo_search_context_button").label = newContext;
            todoSearcher.saveToPrefs();
        }
    }

    this.ChangeCase = function(newCase) {
        if (newCase != todoSearcher._caseSensitive) {
            todoSearcher._caseSensitive = newCase;
            todoSearcher.update();
            todoSearcher.saveToPrefs();
        }
    }

    this.Refresh = function() {
        var text = document.getElementById("todo_markers_textbox").value;
        todoSearcher._markers = text;
        todoSearcher.update();
        todoSearcher.saveToPrefs();
    }

    this.TextboxKeypress = function(e) {
        try {
            if (e.keyCode == 13) { /* enter */
                var text = document.getElementById("todo_markers_textbox").value;
                if (todoSearcher._markers != text) {
                    todoSearcher._markers = text;
                    todoSearcher.update();
                    todoSearcher.saveToPrefs();
                }
            }
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.OnLoad = function() {
        // Ensure find results knows about us
        try {
            _gFindResultsTab_managers[todoId] = null;
            todoSearcher = new ko.extensions.todo.TodoSearcher();
            if (ko.views.manager.currentView) {
                todoSearcher.update();
            }
        } catch (ex) {
            log.exception(ex);
        }
    }

    //RRaver updates
    this.ShowTodoPane = function() {
        ko.uilayout.togglePane('bottom_splitter', 'output_tabs', 'cmd_viewBottomPane');
        ko.uilayout.ensureTabShown('findresults720_tab', true);
        todoSearcher.UpdateTodoStatusbar(true);
    }
    //RRaver updates END
}).apply(ko.extensions.todo);

// Initialize it once Komodo has finished loading
// XXX: TODO: Use an observer or notification mechanism.
addEventListener("load", function() { setTimeout(ko.extensions.todo.OnLoad, 3000); }, false);
