import React from 'react';
import { useDropzone } from 'react-dropzone';

export default () => {
  const [files, setFiles] = React.useState('');
  const onDrop = React.useCallback((acceptedFiles) => {
    setFiles(acceptedFiles.map((file) => file.name).join(', '));
  }, []);
  const { getRootProps, getInputProps, isDragActive, isFocused, isDragAccept, isDragReject } =
    useDropzone({ onDrop });

  const rootClasses = [
    'flex',
    'flex-col',
    'items-center',
    'justify-center',
    'p-5',
    'border-2',
    'border-dashed',
    'rounded',
    'bg-gray-100',
    'text-gray-500',
    'transition-all',
    isFocused && 'bg-blue-100 border-blue-500',
    isDragAccept && 'bg-green-100 border-green-500',
    isDragReject && 'bg-red-100 border-red-500',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div {...getRootProps({ className: rootClasses })}>
      <input {...getInputProps()} />
      {isDragActive ? (
        <p>Drop the files here ...</p>
      ) : (
        <p>{files || "Drag 'n' drop some files here"}</p>
      )}
    </div>
  );
};
