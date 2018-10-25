import {CompositeDisposable, DisplayMarker, TextEditor} from "atom"
import {debounce} from "lodash"
import {GetClientFunction} from "../../../client"
import {isTypescriptEditorWithPath, spanToRange} from "../utils"

export class OccurenceController {
  private readonly disposables = new CompositeDisposable()
  private occurrenceMarkers: DisplayMarker[] = []
  private disposed = false

  constructor(private getClient: GetClientFunction, private editor: TextEditor) {
    this.disposables.add(
      editor.onDidChangeCursorPosition(this.update),
      editor.onDidChangePath(this.update),
      editor.onDidChangeGrammar(this.update),
    )
  }

  public dispose() {
    if (this.disposed) return
    this.disposed = true
    this.disposables.dispose()
    this.clearMarkers()
  }

  private clearMarkers() {
    for (const marker of this.occurrenceMarkers) {
      marker.destroy()
    }
  }

  // tslint:disable-next-line:member-ordering
  private update = debounce(
    async () => {
      if (this.disposed) return
      if (!isTypescriptEditorWithPath(this.editor)) {
        this.clearMarkers()
        return
      }
      const filePath = this.editor.getPath()
      if (filePath === undefined) return
      const client = await this.getClient(filePath)
      if (this.disposed) return

      const pos = this.editor.getLastCursor().getBufferPosition()

      try {
        const result = await client.execute("occurrences", {
          file: filePath,
          line: pos.row + 1,
          offset: pos.column + 1,
        })
        if (this.disposed) return

        const ranges = result.body!.map(spanToRange)

        const newOccurrenceMarkers = ranges.map(range => {
          const oldMarker = this.occurrenceMarkers.find(m => m.getBufferRange().isEqual(range))
          if (oldMarker) return oldMarker
          else {
            const marker = this.editor.markBufferRange(range)
            this.editor.decorateMarker(marker, {
              type: "highlight",
              class: "atom-typescript-occurrence",
            })
            return marker
          }
        })
        for (const m of this.occurrenceMarkers) {
          if (!newOccurrenceMarkers.includes(m)) m.destroy()
        }
        this.occurrenceMarkers = newOccurrenceMarkers
      } catch (e) {
        if (window.atom_typescript_debug) console.error(e)
      }
    },
    100,
    {leading: true},
  )
}
