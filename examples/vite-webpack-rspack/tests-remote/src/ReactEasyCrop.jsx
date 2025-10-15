import React, { useEffect } from 'react';
import Cropper from 'react-easy-crop';

export default () => {
  const cropper = React.useRef();
  const [crop, setCrop] = React.useState({ x: 0, y: 0 });
  const [zoom, setZoom] = React.useState(1);

  const onCropComplete = (croppedArea, croppedAreaPixels) => {
    console.log(croppedArea, croppedAreaPixels);
  };

  useEffect(() => {
    if (cropper.current) {
      cropper.current.containerRef.setAttribute('data-testid', 'e2e-easy-crop');
    }
  }, []);

  return (
    <div className="relative">
      <Cropper
        image="http://localhost:4003/product.webp"
        crop={crop}
        zoom={zoom}
        aspect={4 / 3}
        onCropChange={setCrop}
        onCropComplete={onCropComplete}
        onZoomChange={setZoom}
        ref={cropper}
      />
    </div>
  );
};
