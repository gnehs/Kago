import { useRef } from "react";
import { flatTree, pickedFolderTree } from "@/lib/uploadTree";
import type { FileActions } from "./useFileActions";

/** Opens the browser's file and folder pickers for an upload into a folder. Render `inputs` once, inside the window. */
export function useUploadPicker(actions: FileActions, windowFolder: string) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Where the files picked for an upload go, set as the picker is opened.
  const uploadFolder = useRef<string | null>(null);

  function pick(input: HTMLInputElement | null, folder: string) {
    uploadFolder.current = folder;
    input?.click();
  }

  return {
    pickFiles: (folder: string) => pick(uploadInput.current, folder),
    pickFolder: (folder: string) => pick(folderInput.current, folder),
    inputs: (
      <>
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void actions.upload(flatTree(Array.from(event.target.files ?? [])), uploadFolder.current ?? windowFolder);
            event.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          {...{ webkitdirectory: "" }}
          onChange={(event) => {
            void actions.upload(pickedFolderTree(Array.from(event.target.files ?? [])), uploadFolder.current ?? windowFolder);
            event.target.value = "";
          }}
        />
      </>
    )
  };
}
