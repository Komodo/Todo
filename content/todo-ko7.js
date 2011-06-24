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
    log.setLevel(ko.logging.LOG_DEBUG);

    this.__defineGetter__("manager", function() {
                return ko.findresults.managers[todoId];
            }
    );

    this.TodoSearcher = function() {
        try {		
            var bundleSvc = Components.classes["@mozilla.org/intl/stringbundle;1"]
                    .getService(Components.interfaces.nsIStringBundleService);
            this._locale = bundleSvc.createBundle("chrome://todo/locale/todo.properties");
            this._needsUpdating = false;
            this._updateTimeoutId = null;
            // Current search context is what we will search in, as well as
            // being the string used to get the localized version of the
            // search in context.
            this._currentSearchContext = 'todo.currentFile';
            this._markers = this.GetLocalizedString('todo.pattern');
            this._caseSensitive = true;
            this._origFindOptions = new Object();
            this._todoFindOptions = Components.classes["@activestate.com/koFindOptions;1"]
                        .createInstance(Components.interfaces.koIFindOptions);
            this._todoFindOptions.patternType = this._todoFindOptions.FOT_REGEX_PYTHON;
            this._activeProjectId = "";

            // Initialize settings from prefs
            this.loadFromPrefs();

            // Listen for some Komodo view events
            var obsSvc = Components.classes["@mozilla.org/observer-service;1"].
                               getService(Components.interfaces.nsIObserverService);
            obsSvc.addObserver(this, 'file_changed', false);
            obsSvc.addObserver(this, 'current_project_changed', false);

            var self = this;
            this._handle_num_views_changed_event = function(event) {
                self._handle_num_views_changed();
            }
            this._handle_current_view_changed_event = function(event) {
                self._handle_current_view_changed(event.originalTarget);
            }
            parent.window.addEventListener('view_closed', this._handle_num_views_changed_event, false);
            parent.window.addEventListener('view_opened', this._handle_num_views_changed_event, false);
            parent.window.addEventListener('current_view_changed', this._handle_current_view_changed_event, false);

            /* Komodo 4.x requires us to initially create the findSvc instance */
            var appInfo = Components.classes["@activestate.com/koInfoService;1"].
                            getService(Components.interfaces.koIInfoService);
            if (appInfo.version[0] <= "4") {
                if (findSvc == null) {
                    findSvc = Components.classes["@activestate.com/koFindService;1"]
                              .getService(Components.interfaces.koIFindService);
                }
            }

            // Ensure the search in project menu item has the correct name.
            this.updateMenuItemLabels();
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.TodoSearcher.prototype.onUnload = function() {
        try {
            var obsSvc = Components.classes["@mozilla.org/observer-service;1"].
                               getService(Components.interfaces.nsIObserverService);
            obsSvc.removeObserver(this, 'file_changed');
            obsSvc.removeObserver(this, 'current_project_changed');
            parent.window.removeEventListener('current_view_changed', this._handle_current_view_changed_event, false);
            parent.window.removeEventListener('view_closed', this._handle_num_views_changed_event, false);
            parent.window.removeEventListener('view_opened', this._handle_num_views_changed_event, false);
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
            // Ensure the pref name is a valid property name.
            if ((this._currentSearchContext != "todo.currentFile") &&
                (this._currentSearchContext != "todo.activeProject") &&
                (this._currentSearchContext != "todo.openedFiles")) {
                log.warn("Invalid setting for current search context: " + this._currentSearchContext);
                this._currentSearchContext = "todo.currentFile";
            }
        }
        document.getElementById("todo_search_context_button").label = this.GetLocalizedString(this._currentSearchContext);

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

    this.TodoSearcher.prototype._handle_num_views_changed = function() {
        if (this._currentSearchContext != "todo.activeProject") {
            this._needsUpdating = true;
            // The actual update will happen through the current_view_changed
            // notification event, which will occur soon after this event.
        }
    }

    this.TodoSearcher.prototype._handle_current_view_changed = function(view) {
        log.debug("_handle_current_view_changed");
        if (this._needsUpdating ||
            (this._currentSearchContext == "todo.currentFile")) {
            this.update(view);
            this._needsUpdating = false;
        }
    }

    this.TodoSearcher.prototype.observe = function(subject, topic, data) {
        try {
            log.debug("Observing topic: " + topic);
            switch (topic) {
                case "current_view_changed":
                    this._handle_current_view_changed(topic);
                    break;

                case "view_opened":
                case "view_closed":
                    this._handle_num_views_changed();
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

                case "current_project_changed":
                    var project = ko.projects.manager.getCurrentProject();
                    // This little bit of trickery is necessary in order to
                    // remember the project id, as we can often get a
                    // notification when the project has not changed. Ack!
                    if (!project && this._activeProjectId) {
                        this._activeProjectChanged();
                        this._activeProjectId = "";
                        log.debug("No active project now");
                    } else if (project && project.id != this._activeProjectId) {
                        this._activeProjectChanged();
                        this._activeProjectId = project.id;
                        log.debug("Active project changed to: " + this._activeProjectId);
                    }
                    break;
            }
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.TodoSearcher.prototype.updateMenuItemLabels = function() {
        try {
            // Update the button label.
            var menuitem = document.getElementById("todo_search_context_button");
            menuitem.label = this.GetLocalizedString(this._currentSearchContext);

            // Update the project menuitem label.
            var project = ko.projects.manager.getCurrentProject();
            var project_menuitem = document.getElementById("todo_search_context_menuitem_activeproject");
            var aproj_localized_string = this.GetLocalizedString("todo.activeProject");
            if (!project) {
                project_menuitem.label = aproj_localized_string + " (None)";
            } else {
                // Remove the ".kpf" from the project name.
                var name = project.name.match(/(.*)\.(kpf|komodoproject)/)[1];
                if (!name) {
                    name = project.name;
                }
                project_menuitem.label = aproj_localized_string + " (" + name + ")";
            }
            if (this._currentSearchContext == 'todo.activeProject') {
                menuitem.label = project_menuitem.label;
            }
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.TodoSearcher.prototype._activeProjectChanged = function() {
        try {
            this.updateMenuItemLabels();
            // If the search-in menu is set to the project, update the search
            // results.
            if (this._currentSearchContext == "todo.activeProject") {
                this.update();
            }
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.TodoSearcher.prototype.update = function(view) {
        try {
            log.debug("Updating, view: " + view);
            if (this._updateTimeoutId) {
                // We are updating now, don't need to wait for the timeout
                window.clearTimeout(this._updateTimeoutId);
                this._updateTimeoutId = null;
            }
            if (typeof(view) == 'undefined') {
                view = ko.views.manager.currentView;
            }
            if (!this._markers) {
                // Clear the results.
                this.GetAndClearTheTodoTab(todoId);
                return;
            }
            this.findAll(window, view, this._markers);
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.TodoSearcher.prototype.GetAndClearTheTodoTab = function(id) {
        try {
            // Create the tab or clear it and return its manager.
            var manager = ko.findresults.managers[id];
            if (manager == null) {
                manager = ko.findresults.create(id);
                // Overriding the setDescription method.
                // This requires some knowledge of the internals of the
                // find/replace system. This method gets called every time the
                // find results tree is updated. Since we don't show the
                // description at all, we can pretty much do what we want with
                // it...
                manager.setDescription = function(subDesc /* =null */,
                                                  important /* =false */) {
                    todoSearcher.UpdateTodoStatusbar(manager.view.rowCount);
                }

                ko.findresults.managers[id] = manager;
            } else {
                if (manager.isBusy()) {
                    manager.stopSearch();
                }
                manager.clear();
            }
            return manager;
        } catch(ex) {
            log.exception(ex);
        }
        return null;
    }

    /**
     * Callback handler used to process messages coming back from the find
     * system.
     */
    this.TodoSearcher.prototype.findMsgHandler = function(level, context, msg) {
        ko.statusBar.AddMessage(context+": "+msg, "todo", 3000, true);
    }

    this.TodoSearcher.prototype.findAll = function(editor, view, pattern, patternAlias) {
        var resultsMgr = this.GetAndClearTheTodoTab(todoId);
        if (resultsMgr == null)
            return null;
        // We need a view which contains scintilla, bug 70309 and we
        // need to catch errors when this fails, bug 70730 and bug 70708
        try {
            if ((!view || !view.scintilla) &&
                this._currentSearchContext == 'todo.currentFile') {
                return null;
            }
        } catch (ex) {
            /* no view left */
            return null;
        }

        // Set the find context
        if (this._currentSearchContext == 'todo.openedFiles') {
            this._todoFindContext = Components.classes["@activestate.com/koFindContext;1"]
                        .createInstance(Components.interfaces.koIFindContext);
            this._todoFindContext.type = Components.interfaces.koIFindContext.FCT_ALL_OPEN_DOCS;
        } else if (this._currentSearchContext == 'todo.currentFile') {
            this._todoFindContext = Components.classes["@activestate.com/koFindContext;1"]
                        .createInstance(Components.interfaces.koIFindContext);
            this._todoFindContext.type = Components.interfaces.koIFindContext.FCT_CURRENT_DOC;
        } else if (this._currentSearchContext == 'todo.activeProject') {
            var project = ko.projects.manager.getCurrentProject();
            if (!project)
                return null;
            this._todoFindContext = Components.classes["@activestate.com/koCollectionFindContext;1"]
                        .createInstance(Components.interfaces.koICollectionFindContext);
            this._todoFindContext.type = Components.interfaces.koIFindContext.FCT_IN_COLLECTION;
            this._todoFindContext.add_koIContainer(project);
        }
        // Set the case sensitive find option
        if (this._caseSensitive) {
            this._todoFindOptions.caseSensitivity = this._todoFindOptions.FOC_SENSITIVE;
        } else {
            this._todoFindOptions.caseSensitivity = this._todoFindOptions.FOC_INSENSITIVE;
        }

        resultsMgr.configure(pattern, patternAlias, null, this._todoFindContext,
                             this._todoFindOptions);
        // Don't use show, pops open the output tab when it's closed!
        //resultsMgr.show();

        if (this._currentSearchContext != 'todo.activeProject') {
            resultsMgr.searchStarted();
        }
        var numFilesSearched = null;
        var context = this._todoFindContext;

        var findSessionSvc = Components.classes["@activestate.com/koFindSession;1"].
                                getService(Components.interfaces.koIFindSession);

        // Save original find settings
        var findSvc = Components.classes["@activestate.com/koFindService;1"]
                      .getService(Components.interfaces.koIFindService);
        this._origFindOptions.searchBackward = findSvc.options.searchBackward;
        this._origFindOptions.matchWord= findSvc.options.matchWord;
        this._origFindOptions.patternType = findSvc.options.patternType;
        this._origFindOptions.caseSensitivity = findSvc.options.caseSensitivity;
    
        findSvc.options.searchBackward = false;
        findSvc.options.matchWord = false;
        findSvc.options.patternType = this._todoFindOptions.patternType;
        findSvc.options.caseSensitivity = this._todoFindOptions.caseSensitivity;
        try {
            var fn_FindAllInView = ("find" in ko && "_findAllInView" in ko.find) ?
                                    ko.find._findAllInView /* komodo 7+ */ :
                                    _FindAllInView         /* komodo 6- */;
            if (context.type == Components.interfaces.koIFindContext.FCT_CURRENT_DOC
                || context.type == Components.interfaces.koIFindContext.FCT_SELECTION) {
                //log.debug("ko.find.findAll: find all in '"+
                //              editor.ko.views.manager.currentView.document.displayPath+"'\n");
                fn_FindAllInView(editor, view, context,
                                 pattern, resultsMgr.view);

            } else if (context.type == Components.interfaces.koIFindContext.FCT_ALL_OPEN_DOCS) {
                var viewURI;
                numFilesSearched = 0;
                while (view) {

                    // Deal with K5 v's K6 differences.
                    viewURI = (view.koDoc || view.document).displayPath;

                    if (findSessionSvc.HaveSearchedThisUrlAlready(viewURI)) {
                        log.debug("findAll: have already searched '"+
                                      viewURI+"'\n");
                        break;
                    }

                    log.debug("findAll: find all in '"+viewURI+"'\n");
                    fn_FindAllInView(editor, view, context, pattern, resultsMgr.view);
                    numFilesSearched += 1;

                    view = ("find" in ko && "_getNextView" in ko.find) ?
                            ko.find._getNextView(editor, view) /* komodo 7+ */ :
                            _getNextView(editor, view)         /* komodo 6- */;
                }

            } else if (context.type == Components.interfaces.koIFindContext.FCT_IN_COLLECTION) {
                document.getElementById("findresults-stopsearch-button").removeAttribute("collapsed");
                document.getElementById("findresults-stopsearch-button").removeAttribute("hidden");
                findSvc.findallinfiles(resultsMgr.id, pattern, resultsMgr);

            } else {
                throw("unexpected context: name='" + context.name + "' type=" +
                      context.type);
            }
            // Would be good to pass in the number of files in which hits were
            // found, but don't easily have that value and it's not a biggie.
            if (this._currentSearchContext != 'todo.activeProject') {
                resultsMgr.searchFinished(true, resultsMgr.view.rowCount, null,
                                          numFilesSearched);
            }
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

        findSessionSvc.Reset();
        this.UpdateTodoStatusbar(numTodosFound);

        return numTodosFound;
    }
	
    //RRaver updates
    this.TodoSearcher.prototype.UpdateTodoStatusbar = function(numTodosFound) {
        var todoStatusElem = parent.document.getElementById('statusbar-todo');
        if (numTodosFound > 0) {
            todoStatusElem.hidden = false;
            todoStatusElem.setAttribute("tooltiptext", this.GetFormattedString('todo.todosFound', [numTodosFound]));
        } else {
            /* Hide the todo statusbar item */
            todoStatusElem.hidden = true;
        }

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
            todoSearcher.updateMenuItemLabels();
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

    this.focus = function() {
        if (ko.extensions.todo.manager) {
            ko.extensions.todo.manager.doc.getElementById("findresults").focus();
        }
    }

    this.OnLoad = function() {
        // Ensure find results knows about us
        try {
            ko.findresults.managers[todoId] = null;
            todoSearcher = new ko.extensions.todo.TodoSearcher();
            if (ko.views.manager.currentView) {
                todoSearcher.update();
            }
        } catch (ex) {
            log.exception(ex);
        }
    }

    this.OnUnload = function() {
        todoSearcher.onUnload();
        todoSearcher = null;
    }

    //RRaver updates
    this.ToggleTodoPane = function() {
        // Make the todo tab the current tab that is shown.
        ko.uilayout.toggleTab("findresults720_tabpanel", true);
    }
    //RRaver updates END

}).apply(ko.extensions.todo);

// Initialize it once Komodo has finished loading
addEventListener("load", setTimeout(function() { ko.extensions.todo.OnLoad(); }, 3000));
addEventListener("unload", ko.extensions.todo.OnUnload, false);
