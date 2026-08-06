import { listDriveFiles } from './api';
import { DriveBrowser } from './DriveBrowser';

/** Personal Drive browse/search, beside the app's own uploads. */
export function MyDrivePage() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6">
      <h1 className="mb-4 text-xl font-semibold">My Drive</h1>
      <DriveBrowser rootName="My Drive" fetchPage={listDriveFiles} searchable />
    </div>
  );
}
