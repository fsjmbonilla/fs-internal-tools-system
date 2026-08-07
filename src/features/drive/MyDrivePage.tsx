import { listDriveFiles, uploadToMyDrive } from './api';
import { DriveBrowser } from './DriveBrowser';

/** Personal Drive browse/search, beside the app's own uploads. */
export function MyDrivePage() {
  return (
    <div className="flex h-full w-full flex-col p-3 md:p-4">
      <h1 className="mb-4 text-xl font-semibold">My Drive</h1>
      <DriveBrowser
        rootName="My Drive"
        fetchPage={listDriveFiles}
        searchable
        onDropFiles={async (files, folderId) => {
          for (const file of files) await uploadToMyDrive(file, folderId);
        }}
      />
    </div>
  );
}
