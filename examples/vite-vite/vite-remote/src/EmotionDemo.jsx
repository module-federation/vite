import styled from '@emotion/styled';

const Heading = styled('h1')`
  background-color: ${props => props.bg};
  padding:${props => props.pd};
  color: ${props => props.fg};
`;

export function EmotionDemo() {
    return (
        <div>
            <Heading bg="#008f68" fg="#fae042" pd="50px">
                Heading with a green background and yellow text.
            </Heading>
        </div>
    );
}

export default EmotionDemo;
