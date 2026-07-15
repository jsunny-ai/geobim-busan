import { useCallback, useRef, useState } from "react"
import { FileUp, UploadCloud } from "lucide-react"
import { cn } from "@/lib/utils"

export function DropZone({
  accept,
  file,
  onFile,
  hint,
}: {
  accept: string
  file: File | null
  onFile: (f: File) => void
  hint: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const f = e.dataTransfer.files[0]
      if (f) onFile(f)
    },
    [onFile],
  )

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors",
        dragging
          ? "border-sky-400 bg-sky-400/10"
          : "border-border bg-card/40 hover:border-sky-400/50 hover:bg-card/60",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
        }}
      />
      {file ? (
        <>
          <FileUp className="h-9 w-9 text-sky-300" />
          <div className="max-w-full text-center">
            <p className="break-all text-sm font-medium text-foreground">{file.name}</p>
            <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
          <p className="text-xs text-muted-foreground">클릭하거나 파일을 드래그해 교체</p>
        </>
      ) : (
        <>
          <UploadCloud className="h-9 w-9 text-sky-300" />
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">파일을 드래그하거나 클릭해 선택</p>
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </div>
        </>
      )}
    </div>
  )
}
