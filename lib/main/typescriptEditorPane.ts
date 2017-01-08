import {$} from "atom-space-pen-views"
import {basename} from "path"
import {CompositeDisposable} from "atom"
import {debounce, flatten} from "lodash"
import {spanToRange} from "./atom/utils"
import {TypescriptServiceClient} from "../client/client"
import {TypescriptBuffer} from "./typescriptBuffer"
import {StatusPanel} from "./atom/components/statusPanel"
import * as tooltipManager from './atom/tooltipManager'

interface PaneOptions {
  getClient: (filePath: string) => Promise<TypescriptServiceClient>
  onDispose: (pane: TypescriptEditorPane) => any
  onSave: (pane: TypescriptEditorPane) => any
  statusPanel: StatusPanel
}

export class TypescriptEditorPane implements AtomCore.Disposable {
  // Timestamp for activated event
  activeAt: number

  buffer: TypescriptBuffer
  client: TypescriptServiceClient

  // Path to the project's tsconfig.json
  configFile: string = ""

  filePath: string
  isActive = false
  isTSConfig = false
  isTypescript = false

  private opts: PaneOptions
  private isOpen = false

  readonly occurrenceMarkers: AtomCore.IDisplayBufferMarker[] = []
  readonly editor: AtomCore.IEditor
  readonly subscriptions = new CompositeDisposable()

  constructor(editor: AtomCore.IEditor, opts: PaneOptions) {
    this.editor = editor
    this.filePath = editor.getPath()
    this.opts = opts
    this.buffer = new TypescriptBuffer(editor.buffer, opts.getClient)
      .on("changed", this.onChanged)
      .on("opened", this.onOpened)
      .on("saved", this.onSaved)

    this.isTypescript = isTypescriptGrammar(editor.getGrammar())

    this.subscriptions.add(editor.onDidChangeGrammar(grammar => {
      this.isTypescript = isTypescriptGrammar(grammar)
    }))

    if (this.filePath) {
      this.isTSConfig = basename(this.filePath) === "tsconfig.json"
    }

    this.setupTooltipView()
  }

  dispose() {
    this.subscriptions.dispose()
    this.opts.onDispose(this)
  }

  onActivated = () => {
    this.activeAt = Date.now()
    this.isActive = true

    if (this.isTypescript && this.filePath) {
      this.opts.statusPanel.show()

      if (this.client) {
        // The first activation might happen before we even have a client
        this.client.executeGetErr({
          files: [this.filePath],
          delay: 100
        })

        this.opts.statusPanel.setVersion(this.client.version)
      }
    }

    this.opts.statusPanel.setTsConfigPath(this.configFile)
  }

  onChanged = () => {
    console.warn("changed event")

    this.opts.statusPanel.setBuildStatus(undefined)

    this.client.executeGetErr({
      files: [this.filePath],
      delay: 100
    })
  }

  onDeactivated = () => {
    this.isActive = false
    this.opts.statusPanel.hide()
  }

  clearOccurrenceMarkers() {
    for (const marker of this.occurrenceMarkers) {
      marker.destroy()
    }
  }

  updateMarkers = debounce(() => {
    const pos = this.editor.getLastCursor().getBufferPosition()

    this.client.executeOccurances({
      file: this.filePath,
      line: pos.row+1,
      offset: pos.column+1
    }).then(result => {
      this.clearOccurrenceMarkers()

      for (const ref of result.body!) {
        const marker = this.editor.markBufferRange(spanToRange(ref))
        this.editor.decorateMarker(marker as any, {
          type: "highlight",
          class: "atom-typescript-occurrence"
        })
        this.occurrenceMarkers.push(marker)
      }
    }).catch(() => this.clearOccurrenceMarkers())
  }, 100)

  onDidChangeCursorPosition = ({textChanged}) => {
    if (!this.isTypescript) {
      return
    }

    if (textChanged) {
      this.clearOccurrenceMarkers()
      return
    }

    this.updateMarkers()
  }

  onDidDestroy = () => {
    this.dispose()
  }

  onOpened = async () => {
    console.warn("opened event")

    this.client = await this.opts.getClient(this.filePath)

    this.subscriptions.add(this.editor.onDidChangeCursorPosition(this.onDidChangeCursorPosition))
    this.subscriptions.add(this.editor.onDidDestroy(this.onDidDestroy))

    if (this.isActive) {
      this.opts.statusPanel.setVersion(this.client.version)
    }

    if (this.isTypescript && this.filePath) {
      this.client.executeGetErr({
        files: [this.filePath],
        delay: 100
      })

      this.isOpen = true

      this.client.executeProjectInfo({
        needFileNameList: false,
        file: this.filePath
      }).then(result => {
        this.configFile = result.body!.configFileName

        if (this.isActive) {
          this.opts.statusPanel.setTsConfigPath(this.configFile)
        }
      }, error => null)
    }
  }

  onSaved = ()  => {
    console.warn("saved event")
    if (this.opts.onSave) {
      this.opts.onSave(this)
    }

    this.compileOnSave()

    // if (this.filePath !== event.path) {
    //   this.client = await this.opts.getClient(event.path)
    //   this.filePath = event.path
    //   this.isTSConfig = basename(this.filePath) === "tsconfig.json"
    // }
  }

  async compileOnSave() {
    const result = await this.client.executeCompileOnSaveAffectedFileList({
      file: this.filePath
    })

    this.opts.statusPanel.setBuildStatus(undefined)

    const fileNames = flatten(result.body.map(project => project.fileNames))

    if (fileNames.length === 0) {
      return
    }

    try {
      const promises = fileNames.map(file => this.client.executeCompileOnSaveEmitFile({file}))
      const saved = await Promise.all(promises)

      if (!saved.every(res => res.body)) {
        throw new Error("Some files failed to emit")
      }

      this.opts.statusPanel.setBuildStatus({
        success: true
      })

    } catch (error) {
      console.error("Save failed with error", error)
      this.opts.statusPanel.setBuildStatus({
        success: false
      })
    }
  }

  setupTooltipView() {
    // subscribe for tooltips
    // inspiration : https://github.com/chaika2013/ide-haskell
    const editorView = $(atom.views.getView(this.editor))
    tooltipManager.attach(editorView, this.editor)
  }
}

function isTypescriptGrammar(grammar: AtomCore.IGrammar): boolean {
  return grammar.scopeName === "source.ts" || grammar.scopeName === "source.tsx"
}
