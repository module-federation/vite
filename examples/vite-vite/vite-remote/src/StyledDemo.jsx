import React from 'react';
import styled from 'styled-components';

export default styled(function ({ className }) {
    return <div className={className}>Styled components</div>;
})`
  background: salmon;
  padding: 30px;
`;