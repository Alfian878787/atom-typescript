"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Atom = require("atom");
const atom_1 = require("atom");
const lodash_1 = require("lodash");
const path = require("path");
const client_1 = require("../client");
const utils_1 = require("../utils");
const autoCompleteProvider_1 = require("./atom/autoCompleteProvider");
const codefix_1 = require("./atom/codefix");
const commands_1 = require("./atom/commands");
const statusPanel_1 = require("./atom/components/statusPanel");
const datatipProvider_1 = require("./atom/datatipProvider");
const editorPositionHistoryManager_1 = require("./atom/editorPositionHistoryManager");
const hyperclickProvider_1 = require("./atom/hyperclickProvider");
const manager_1 = require("./atom/occurrence/manager");
const manager_2 = require("./atom/sigHelp/manager");
const sigHelpProvider_1 = require("./atom/sigHelpProvider");
const manager_3 = require("./atom/tooltips/manager");
const utils_2 = require("./atom/utils");
const semanticViewController_1 = require("./atom/views/outline/semanticViewController");
const symbolsViewController_1 = require("./atom/views/symbols/symbolsViewController");
const errorPusher_1 = require("./errorPusher");
const typescriptBuffer_1 = require("./typescriptBuffer");
const typescriptEditorPane_1 = require("./typescriptEditorPane");
class PluginManager {
    constructor(state) {
        this.panes = []; // TODO: do we need it?
        this.usingBuiltinTooltipManager = true;
        this.usingBuiltinSigHelpManager = true;
        this.clearErrors = () => {
            this.errorPusher.clear();
        };
        this.getClient = async (filePath) => {
            const pane = this.panes.find(p => p.buffer.getPath() === filePath);
            if (pane && pane.client) {
                return pane.client;
            }
            return this.clientResolver.get(filePath);
        };
        this.killAllServers = () => this.clientResolver.killAllServers();
        this.getStatusPanel = () => this.statusPanel;
        this.withTypescriptBuffer = async (filePath, action) => {
            const normalizedFilePath = path.normalize(filePath);
            const pane = this.panes.find(p => p.buffer.getPath() === normalizedFilePath);
            if (pane)
                return action(pane.buffer);
            // no open buffer
            const buffer = await Atom.TextBuffer.load(normalizedFilePath);
            try {
                const tsbuffer = typescriptBuffer_1.TypescriptBuffer.create(buffer, fp => this.clientResolver.get(fp));
                return await action(tsbuffer);
            }
            finally {
                if (buffer.isModified())
                    await buffer.save();
                buffer.destroy();
            }
        };
        this.applyEdits = async (edits) => void Promise.all(edits.map(edit => this.withTypescriptBuffer(edit.fileName, async (buffer) => {
            buffer.buffer.transact(() => {
                const changes = edit.textChanges
                    .map(e => ({ range: utils_2.spanToRange(e), newText: e.newText }))
                    .sort((a, b) => b.range.compare(a.range));
                for (const change of changes) {
                    buffer.buffer.setTextInRange(change.range, change.newText);
                }
            });
            return buffer.flush();
        })));
        this.getSemanticViewController = () => this.semanticViewController;
        this.getSymbolsViewController = () => this.symbolsViewController;
        this.getEditorPositionHistoryManager = () => this.editorPosHist;
        this.subscriptions = new atom_1.CompositeDisposable();
        this.clientResolver = new client_1.ClientResolver();
        this.subscriptions.add(this.clientResolver);
        this.statusPanel = new statusPanel_1.StatusPanel();
        this.subscriptions.add(this.clientResolver.on("pendingRequestsChange", lodash_1.throttle(() => {
            utils_1.handlePromise(this.statusPanel.update({
                pending: Array.from(this.clientResolver.getAllPending()),
            }));
        }, 100, { leading: false })), this.statusPanel);
        this.errorPusher = new errorPusher_1.ErrorPusher();
        this.subscriptions.add(this.errorPusher);
        // NOTE: This has to run before withTypescriptBuffer is used to populate this.panes
        this.subscribeEditors();
        this.codefixProvider = new codefix_1.CodefixProvider(this.clientResolver, this.errorPusher, this.applyEdits);
        this.subscriptions.add(this.codefixProvider);
        this.semanticViewController = new semanticViewController_1.SemanticViewController(this.withTypescriptBuffer);
        this.subscriptions.add(this.semanticViewController);
        this.symbolsViewController = new symbolsViewController_1.SymbolsViewController(this);
        this.subscriptions.add(this.symbolsViewController);
        this.editorPosHist = new editorPositionHistoryManager_1.EditorPositionHistoryManager(state && state.editorPosHistState);
        this.subscriptions.add(this.editorPosHist);
        this.tooltipManager = new manager_3.TooltipManager(this.getClient);
        this.subscriptions.add(this.tooltipManager);
        this.sigHelpManager = new manager_2.SigHelpManager(this);
        this.subscriptions.add(this.sigHelpManager);
        this.occurrenceManager = new manager_1.OccurrenceManager(this.getClient);
        this.subscriptions.add(this.occurrenceManager);
        // Register the commands
        this.subscriptions.add(commands_1.registerCommands(this));
    }
    destroy() {
        this.subscriptions.dispose();
    }
    serialize() {
        return {
            version: "0.1",
            editorPosHistState: this.editorPosHist.serialize(),
        };
    }
    consumeLinter(register) {
        const linter = register({
            name: "TypeScript",
        });
        this.errorPusher.setLinter(linter);
        this.clientResolver.on("diagnostics", ({ type, filePath, diagnostics }) => {
            this.errorPusher.setErrors(type, filePath, diagnostics);
        });
    }
    consumeStatusBar(statusBar) {
        let statusPriority = 100;
        for (const panel of statusBar.getRightTiles()) {
            if (atom.views.getView(panel.getItem()).tagName === "GRAMMAR-SELECTOR-STATUS") {
                statusPriority = panel.getPriority() - 1;
            }
        }
        const tile = statusBar.addRightTile({
            item: this.statusPanel,
            priority: statusPriority,
        });
        const disp = new Atom.Disposable(() => {
            tile.destroy();
        });
        this.subscriptions.add(disp);
        return disp;
    }
    consumeDatatipService(datatip) {
        if (atom.config.get("atom-typescript.preferBuiltinTooltips"))
            return;
        const disp = datatip.addProvider(new datatipProvider_1.TSDatatipProvider(this.getClient));
        this.subscriptions.add(disp);
        this.tooltipManager.dispose();
        this.usingBuiltinTooltipManager = false;
        return disp;
    }
    consumeSigHelpService(registry) {
        if (atom.config.get("atom-typescript.preferBuiltinSigHelp"))
            return;
        const disp = registry(new sigHelpProvider_1.TSSigHelpProvider(this.getClient, this.withTypescriptBuffer));
        this.subscriptions.add(disp);
        this.sigHelpManager.dispose();
        this.usingBuiltinSigHelpManager = false;
        return disp;
    }
    // Registering an autocomplete provider
    provideAutocomplete() {
        return [
            new autoCompleteProvider_1.AutocompleteProvider(this.clientResolver, {
                withTypescriptBuffer: this.withTypescriptBuffer,
            }),
        ];
    }
    provideIntentions() {
        return new codefix_1.IntentionsProvider(this.codefixProvider);
    }
    provideCodeActions() {
        return new codefix_1.CodeActionsProvider(this.codefixProvider);
    }
    provideHyperclick() {
        return hyperclickProvider_1.getHyperclickProvider(this.clientResolver, this.editorPosHist);
    }
    async showTooltipAt(ed) {
        if (this.usingBuiltinTooltipManager)
            await this.tooltipManager.showExpressionAt(ed);
        else
            await atom.commands.dispatch(atom.views.getView(ed), "datatip:toggle");
    }
    async showSigHelpAt(ed) {
        if (this.usingBuiltinSigHelpManager)
            await this.sigHelpManager.showTooltipAt(ed);
        else
            await atom.commands.dispatch(atom.views.getView(ed), "signature-help:show");
    }
    hideSigHelpAt(ed) {
        if (this.usingBuiltinSigHelpManager)
            return this.sigHelpManager.hideTooltipAt(ed);
        else
            return false;
    }
    subscribeEditors() {
        let activePane;
        this.subscriptions.add(atom.workspace.observeTextEditors((editor) => {
            this.panes.push(new typescriptEditorPane_1.TypescriptEditorPane(editor, {
                getClient: (filePath) => this.clientResolver.get(filePath),
                onClose: filePath => {
                    // Clear errors if any from this file
                    this.errorPusher.setErrors("syntaxDiag", filePath, []);
                    this.errorPusher.setErrors("semanticDiag", filePath, []);
                },
                onDispose: pane => {
                    if (activePane === pane) {
                        activePane = undefined;
                    }
                    this.panes.splice(this.panes.indexOf(pane), 1);
                },
                onSave: lodash_1.debounce((pane) => {
                    if (!pane.client) {
                        return;
                    }
                    const files = [];
                    for (const p of this.panes.sort((a, b) => a.activeAt - b.activeAt)) {
                        const filePath = p.buffer.getPath();
                        if (filePath !== undefined && p.isTypescript && p.client === pane.client) {
                            files.push(filePath);
                        }
                    }
                    utils_1.handlePromise(pane.client.execute("geterr", { files, delay: 100 }));
                }, 50),
                statusPanel: this.statusPanel,
            }));
        }));
        this.subscriptions.add(atom.workspace.observeActiveTextEditor((editor) => {
            if (activePane) {
                activePane.onDeactivated();
                activePane = undefined;
            }
            const pane = this.panes.find(p => p.editor === editor);
            if (pane) {
                activePane = pane;
                pane.onActivated();
            }
        }));
    }
}
exports.PluginManager = PluginManager;
//# sourceMappingURL=pluginManager.js.map